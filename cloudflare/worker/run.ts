import { EightClient, type EightToken } from "./eight";
import type { Env } from "./env";
import { reconcileSchedule, type ScheduleState } from "./schedule/engine";
import {
  discardCommandState,
  listConnectedAccounts,
  saveRun,
  saveRunError,
  saveSkippedRun,
  saveToken,
  type Account,
} from "./store";

const TOKEN_BUFFER_MS = 2 * 60_000;

function previousState(account: Account): ScheduleState | null {
  if (!account.lastCommandKnown || !account.cycleId) return null;
  return {
    cycleId: account.cycleId,
    lastCommandedLevel: account.lastCommandedLevel,
    manualOverride: account.manualOverride,
    overrideLevel: account.overrideLevel,
  };
}

async function validToken(
  account: Account,
  env: Env,
  client: EightClient,
  now: Date,
): Promise<EightToken> {
  if (!account.token) throw new Error("Eight Sleep account is not connected");
  if (account.token.expiresAt > now.getTime() + TOKEN_BUFFER_MS) return account.token;
  const token = await client.refresh(account.token.refreshToken, account.token.userId);
  await saveToken(env, account.accessEmail, token);
  return token;
}

async function runAccount(
  account: Account,
  env: Env,
  client: EightClient,
  now: Date,
): Promise<void> {
  if (account.paused) {
    await saveSkippedRun(env, account.accessEmail);
    return;
  }
  let token = await validToken(account, env, client, now);
  let status;
  try {
    status = await client.getHeatingStatus(token);
  } catch (error) {
    // An access token can be revoked before its reported expiry.
    if (!(error instanceof Error) || !("status" in error) || error.status !== 401) throw error;
    token = await client.refresh(token.refreshToken, token.userId);
    await saveToken(env, account.accessEmail, token);
    status = await client.getHeatingStatus(token);
  }
  const observedLevel = status.isHeating ? status.heatingLevel / 10 : null;
  const result = reconcileSchedule({
    profile: account.settings,
    now,
    observedLevel,
    previous: previousState(account),
  });
  if (result.commandRequired) {
    try {
      if (result.command === null) {
        await client.turnOff(token);
      } else {
        if (!status.isHeating) await client.turnOn(token);
        await client.setLevel(token, token.userId, result.command * 10);
      }
    } catch (error) {
      // A multi-step write can partly succeed. Reconcile from the live bed on
      // the next run instead of mistaking that partial state for manual input.
      await discardCommandState(env, account.accessEmail);
      throw error;
    }
  }
  account.cycleId = result.nextState.cycleId;
  account.lastCommandedLevel = result.nextState.lastCommandedLevel;
  account.lastCommandKnown = true;
  account.manualOverride = result.nextState.manualOverride;
  account.overrideLevel = result.nextState.overrideLevel;
  try {
    await saveRun(env, account);
  } catch (error) {
    if (result.commandRequired) {
      // The bed may already have changed. Drop the old command marker so the
      // next tick reads its actual state without classifying our write as manual.
      await discardCommandState(env, account.accessEmail);
    }
    throw error;
  }
}

/** Invoked only by Cloudflare's scheduled event, never by a public HTTP route. */
export async function runScheduled(
  env: Env,
  now = new Date(),
  client = new EightClient(),
): Promise<void> {
  if (env.CONTROL_ENABLED !== "true") return;
  const accounts = await listConnectedAccounts(env);
  const failures: string[] = [];
  for (const account of accounts) {
    try {
      await runAccount(account, env, client, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown scheduler failure";
      await saveRunError(env, account.accessEmail, message);
      failures.push(`${account.accessEmail}: ${message}`);
    }
  }
  if (failures.length) throw new Error(`Schedule failed for ${failures.join("; ")}`);
}
