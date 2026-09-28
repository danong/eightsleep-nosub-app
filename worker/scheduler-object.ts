import { DurableObject } from "cloudflare:workers";
import { EightApiError, EightClient, observedTargetLevel, type EightToken } from "./eight";
import type { Env } from "./env";
import {
  nextControlAt,
  previewSchedule,
  reconcileSchedule,
  scheduleTimeline,
  type ScheduleTimeline,
} from "./schedule/engine";
import {
  newAccount,
  readToken,
  writeToken,
  type AccountState,
  type Settings,
} from "./account-state";
import { immediateActionAt, retrySchedule } from "./scheduler-timing";
import { appendActivity, buildActivityEntry, type ActivityEntry } from "./activity";

export type { Settings } from "./account-state";

const TOKEN_BUFFER_MS = 2 * 60_000;
const STALE_WORK = "Account changed while scheduled work was in progress";

type PublicStatus = {
  connected: boolean;
  configured: boolean;
  paused: boolean;
  controlEnabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  nextActionAt: string | null;
  nextActionLabel: string | null;
  timeline: ScheduleTimeline | null;
  activity: ActivityEntry[];
};

export class SchedulerObject extends DurableObject<Env> {
  private readonly client = new EightClient();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async getSettings(email: string): Promise<Settings> {
    return (await this.load(email)).settings;
  }

  async getStatus(email: string): Promise<PublicStatus> {
    const account = await this.load(email);
    let nextActionAt: string | null = null;
    let nextActionLabel: string | null = null;
    const now = new Date();
    const timeline = account.configured ? scheduleTimeline(account.settings, now) : null;
    if (account.configured) {
      const at = nextControlAt(account.settings, now);
      const preview = previewSchedule(account.settings, new Date(at.getTime() - 1_000));
      nextActionAt = at.toISOString();
      nextActionLabel = preview.nextActionLabel;
    }
    return {
      connected: Boolean(account.userId && account.encryptedRefreshToken),
      configured: account.configured,
      paused: account.paused,
      controlEnabled: this.env.CONTROL_ENABLED === "true",
      lastRunAt: account.lastRunAt,
      lastError: account.lastError,
      nextActionAt,
      nextActionLabel,
      timeline,
      activity: account.activity ?? [],
    };
  }

  async putSettings(email: string, settings: Settings): Promise<void> {
    await this.mutate(async () => {
      const account = await this.load(email);
      const original = structuredClone(account);
      account.settings = structuredClone(settings);
      account.configured = true;
      account.cycleId = null;
      account.commandKnown = false;
      account.manualOverride = false;
      account.overrideLevel = null;
      account.retryAt = null;
      account.failureCount = 0;
      account.nextActionAt = immediateActionAt(Date.now());
      if (await this.saveMutation(original, account)) await this.rearm();
    });
  }

  async setPaused(email: string, paused: boolean): Promise<void> {
    await this.mutate(async () => {
      const account = await this.load(email);
      const original = structuredClone(account);
      account.paused = paused;
      if (!paused && account.configured && account.userId)
        account.nextActionAt = immediateActionAt(Date.now());
      if (await this.saveMutation(original, account)) await this.rearm();
    });
  }

  async connectAccount(email: string, eightEmail: string, password: string): Promise<void> {
    const token = await this.client.login(eightEmail, password);
    await this.client.getHeatingStatus(token);
    await this.mutate(async () => {
      const account = await this.load(email);
      const original = structuredClone(account);
      account.eightEmail = eightEmail.trim().toLowerCase();
      await writeToken(account, token, this.env.TOKEN_KEY);
      account.cycleId = null;
      account.commandKnown = false;
      account.manualOverride = false;
      account.overrideLevel = null;
      account.lastError = null;
      account.retryAt = null;
      account.failureCount = 0;
      if (account.configured) account.nextActionAt = immediateActionAt(Date.now());
      if (await this.saveMutation(original, account)) await this.rearm();
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const accounts = await this.accounts();
    for (const listed of accounts) {
      const snapshot = await this.accountSnapshot(listed.email);
      if (!snapshot) continue;
      const { account, generation } = snapshot;
      if (!account.configured || account.paused || !account.userId) continue;
      const due = Math.min(
        account.nextActionAt ?? this.nextAt(account, now).getTime(),
        account.retryAt ?? Number.POSITIVE_INFINITY,
      );
      if (due > now) continue;
      // When control is disabled, consume the due boundary and retain the
      // next one. A later deployment enabling control will still have an alarm.
      if (this.env.CONTROL_ENABLED !== "true") {
        account.retryAt = null;
        account.nextActionAt = this.nextAt(account, now + 1).getTime();
        try {
          await this.saveIfCurrent(account, generation);
        } catch {
          // Other accounts can still consume their due boundary.
        }
        continue;
      }
      try {
        await this.runAccount(account, new Date(now), generation);
      } catch (error) {
        if (error instanceof Error && error.message === STALE_WORK) continue;
        await this.recordFailure(
          account.email,
          now,
          error,
          generation,
          buildActivityEntry({
            at: new Date(now).toISOString(),
            observedAvailable: false,
            observedLevel: null,
            scheduledLevel: previewSchedule(account.settings, new Date(now)).desiredLevel,
            commandLevel: null,
            commandAttempted: false,
            commandIssued: false,
            detectedManualOverride: false,
            failed: true,
          }),
        ).catch(() => undefined);
      }
    }
    await this.mutate(() => this.rearm());
  }

  private async runAccount(account: AccountState, now: Date, generation: number): Promise<void> {
    let token = await this.validToken(account, now, generation);
    await this.assertCurrent(account.email, generation);
    let status;
    try {
      status = await this.client.getHeatingStatus(token);
    } catch (error) {
      if (!(error instanceof EightApiError) || error.status !== 401) throw error;
      token = await this.refreshToken(account, token, generation);
      await this.assertCurrent(account.email, generation);
      status = await this.client.getHeatingStatus(token);
    }
    await this.assertCurrent(account.email, generation);
    const observedLevel = observedTargetLevel(status);
    const scheduledLevel = previewSchedule(account.settings, now).desiredLevel;
    const result = reconcileSchedule({
      profile: account.settings,
      now,
      observedLevel,
      previous:
        account.commandKnown && account.cycleId
          ? {
              cycleId: account.cycleId,
              lastCommandedLevel: account.lastCommandedLevel,
              manualOverride: account.manualOverride,
              overrideLevel: account.overrideLevel,
            }
          : null,
    });
    const detectedManualOverride = result.manualOverride && !account.manualOverride;
    let commandAttempted = false;
    let commandIssued = false;
    let commandCompletedAt: string | null = null;
    try {
      if (result.commandRequired) {
        // Persist an unknown command marker before any bed write. If the bed
        // accepts a write but the following state save fails, retry reads live
        // state without treating our write as a manual adjustment.
        account.commandKnown = false;
        account.cycleId = null;
        account.manualOverride = false;
        account.overrideLevel = null;
        await this.saveIfCurrent(account, generation);
        await this.assertCurrent(account.email, generation);
        commandAttempted = true;
        if (result.command === null) await this.client.turnOff(token);
        else {
          if (!status.isHeating) await this.client.turnOn(token);
          await this.client.setLevel(token, token.userId, result.command * 10);
        }
        await this.assertCurrent(account.email, generation);
        commandIssued = true;
        commandCompletedAt = new Date().toISOString();
      }
      account.cycleId = result.nextState.cycleId;
      account.lastCommandedLevel = result.nextState.lastCommandedLevel;
      account.commandKnown = true;
      account.manualOverride = result.nextState.manualOverride;
      account.overrideLevel = result.nextState.overrideLevel;
      account.lastRunAt = now.toISOString();
      account.lastError = null;
      account.retryAt = null;
      account.failureCount = 0;
      account.nextActionAt = this.nextAt(account, now.getTime() + 1).getTime();
      account.activity = appendActivity(
        account.activity,
        buildActivityEntry({
          at: commandCompletedAt ?? now.toISOString(),
          observedAvailable: true,
          observedLevel,
          scheduledLevel,
          commandLevel: result.commandRequired ? result.command : null,
          commandAttempted,
          commandIssued,
          detectedManualOverride,
        }),
      );
      await this.saveIfCurrent(account, generation);
    } catch (error) {
      if (error instanceof Error && error.message === STALE_WORK) throw error;
      await this.recordFailure(
        account.email,
        now.getTime(),
        error,
        generation,
        buildActivityEntry({
          at: new Date().toISOString(),
          observedAvailable: true,
          observedLevel,
          scheduledLevel,
          commandLevel: result.commandRequired ? result.command : null,
          commandAttempted,
          commandIssued,
          detectedManualOverride,
          failed: true,
        }),
      ).catch(() => undefined);
    }
  }

  private async validToken(
    account: AccountState,
    now: Date,
    generation: number,
  ): Promise<EightToken> {
    const token = await readToken(account, this.env.TOKEN_KEY);
    if (!token) throw new Error("Eight Sleep account is not connected");
    if (token.expiresAt > now.getTime() + TOKEN_BUFFER_MS) return token;
    return this.refreshToken(account, token, generation);
  }

  private async refreshToken(
    account: AccountState,
    old: EightToken,
    generation: number,
  ): Promise<EightToken> {
    const token = await this.client.refresh(old.refreshToken, old.userId);
    await this.assertCurrent(account.email, generation);
    await writeToken(account, token, this.env.TOKEN_KEY);
    await this.saveIfCurrent(account, generation);
    return token;
  }

  private async load(email: string): Promise<AccountState> {
    const key = this.key(email);
    const account = await this.ctx.storage.get<AccountState>(key);
    if (account) return account;
    const created = newAccount(email);
    await this.ctx.storage.put(key, created);
    return created;
  }

  private async accounts(): Promise<AccountState[]> {
    const values = await this.ctx.storage.list<AccountState>({ prefix: "account:" });
    return [...values.values()];
  }

  private async accountSnapshot(
    email: string,
  ): Promise<{ account: AccountState; generation: number } | null> {
    return this.ctx.storage.transaction(async (transaction) => {
      const account = await transaction.get<AccountState>(this.key(email));
      if (!account) return null;
      const generation = (await transaction.get<number>(this.revisionKey(email))) ?? 0;
      return { account, generation };
    });
  }

  private async save(account: AccountState): Promise<void> {
    await this.ctx.storage.put(this.key(account.email), account);
  }

  private async saveMutation(original: AccountState, updated: AccountState): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const revisionKey = this.revisionKey(updated.email);
      const revision = (await transaction.get<number>(revisionKey)) ?? 0;
      const current = (await transaction.get<AccountState>(this.key(updated.email))) ?? original;
      let changed = false;
      for (const key of Object.keys(updated) as (keyof AccountState)[]) {
        if (JSON.stringify(original[key]) !== JSON.stringify(updated[key])) {
          changed = true;
          (current[key] as unknown) = updated[key];
        }
      }
      if (!changed) return false;
      await transaction.put(revisionKey, revision + 1);
      await transaction.put(this.key(updated.email), current);
      return true;
    });
  }

  private async saveIfCurrent(account: AccountState, revision: number): Promise<void> {
    const current = await this.ctx.storage.transaction(async (transaction) => {
      const storedRevision = (await transaction.get<number>(this.revisionKey(account.email))) ?? 0;
      if (storedRevision !== revision) return false;
      await transaction.put(this.key(account.email), account);
      return true;
    });
    if (!current) throw new Error(STALE_WORK);
  }

  private async generation(email: string): Promise<number> {
    return (await this.ctx.storage.get<number>(this.revisionKey(email))) ?? 0;
  }

  private async assertCurrent(email: string, revision: number): Promise<void> {
    if ((await this.generation(email)) !== revision) throw new Error(STALE_WORK);
  }

  private async recordFailure(
    email: string,
    now: number,
    error: unknown,
    revision: number,
    activity: ActivityEntry,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const storedRevision = (await transaction.get<number>(this.revisionKey(email))) ?? 0;
      if (storedRevision !== revision) return;
      const account = await transaction.get<AccountState>(this.key(email));
      if (!account) return;
      const retry = retrySchedule(
        account.failureCount,
        now,
        account.nextActionAt,
        this.nextAt(account, now + 1).getTime(),
      );
      account.failureCount = retry.failureCount;
      account.retryAt = retry.retryAt;
      account.nextActionAt = retry.nextActionAt;
      account.lastRunAt = new Date(now).toISOString();
      account.lastError =
        error instanceof Error ? error.message.slice(0, 300) : "Unknown scheduler failure";
      account.activity = appendActivity(account.activity, {
        ...activity,
        error: "Scheduler run failed",
      });
      await transaction.put(this.key(email), account);
    });
  }

  private key(email: string): string {
    return `account:${email.trim().toLowerCase()}`;
  }

  private revisionKey(email: string): string {
    return `revision:${email.trim().toLowerCase()}`;
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }

  private nextAt(account: AccountState, from = Date.now()): Date {
    return nextControlAt(account.settings, new Date(from));
  }

  private async rearm(): Promise<void> {
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const account of await this.accounts()) {
      if (!account.configured || account.paused || !account.userId) continue;
      const scheduled = account.nextActionAt ?? this.nextAt(account, now).getTime();
      const due = account.retryAt === null ? scheduled : Math.min(scheduled, account.retryAt);
      if (due < earliest) earliest = due;
    }
    if (Number.isFinite(earliest)) {
      const desired = Math.max(now + 1_000, earliest);
      await this.ctx.storage.setAlarm(desired);
    } else await this.ctx.storage.deleteAlarm();
  }
}
