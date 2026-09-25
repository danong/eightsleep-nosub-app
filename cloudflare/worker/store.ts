import type { EightToken } from "./eight";
import type { Env } from "./env";
import { seal, unseal } from "./secrets";

export interface Settings {
  bedtime: string;
  wakeTime: string;
  timezone: string;
  levels: { early: number; middle: number; late: number };
}

interface AccountRow {
  access_email: string;
  eight_email: string | null;
  eight_user_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  bedtime: string;
  wake_time: string;
  timezone: string;
  early_level: number;
  middle_level: number;
  late_level: number;
  settings_saved: number;
  paused: number;
  cycle_id: string | null;
  last_commanded_level: number | null;
  last_command_known: number;
  manual_override: number;
  override_level: number | null;
  last_run_at: string | null;
  last_error: string | null;
}

export interface Account {
  accessEmail: string;
  eightEmail: string | null;
  token: EightToken | null;
  settings: Settings;
  configured: boolean;
  paused: boolean;
  cycleId: string | null;
  lastCommandedLevel: number | null;
  lastCommandKnown: boolean;
  manualOverride: boolean;
  overrideLevel: number | null;
  lastRunAt: string | null;
  lastError: string | null;
}

async function fromRow(row: AccountRow, env: Env): Promise<Account> {
  return {
    accessEmail: row.access_email,
    eightEmail: row.eight_email,
    token:
      row.eight_user_id && row.access_token && row.refresh_token && row.token_expires_at
        ? {
            userId: row.eight_user_id,
            accessToken: await unseal(row.access_token, env.TOKEN_KEY),
            refreshToken: await unseal(row.refresh_token, env.TOKEN_KEY),
            expiresAt: row.token_expires_at,
          }
        : null,
    settings: {
      bedtime: row.bedtime,
      wakeTime: row.wake_time,
      timezone: row.timezone,
      levels: { early: row.early_level, middle: row.middle_level, late: row.late_level },
    },
    configured: row.settings_saved === 1,
    paused: row.paused === 1,
    cycleId: row.cycle_id,
    lastCommandedLevel: row.last_commanded_level,
    lastCommandKnown: row.last_command_known === 1,
    manualOverride: row.manual_override === 1,
    overrideLevel: row.override_level,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
  };
}

export async function getAccount(env: Env, email: string): Promise<Account> {
  await env.DB.prepare("INSERT OR IGNORE INTO accounts (access_email) VALUES (?)")
    .bind(email)
    .run();
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE access_email = ?")
    .bind(email)
    .first<AccountRow>();
  if (!row) throw new Error("Account could not be loaded");
  return fromRow(row, env);
}

export async function listConnectedAccounts(env: Env): Promise<Account[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM accounts WHERE refresh_token IS NOT NULL AND settings_saved = 1",
  ).all<AccountRow>();
  return Promise.all(result.results.map((row) => fromRow(row, env)));
}

export async function updateSettings(env: Env, email: string, settings: Settings): Promise<void> {
  await getAccount(env, email);
  await env.DB.prepare(
    `UPDATE accounts SET bedtime = ?, wake_time = ?, timezone = ?, early_level = ?, middle_level = ?, late_level = ?, settings_saved = 1,
    cycle_id = NULL, last_command_known = 0, manual_override = 0, override_level = NULL
    WHERE access_email = ?`,
  )
    .bind(
      settings.bedtime,
      settings.wakeTime,
      settings.timezone,
      settings.levels.early,
      settings.levels.middle,
      settings.levels.late,
      email,
    )
    .run();
}

export async function updatePaused(env: Env, email: string, paused: boolean): Promise<void> {
  await getAccount(env, email);
  await env.DB.prepare("UPDATE accounts SET paused = ? WHERE access_email = ?")
    .bind(paused ? 1 : 0, email)
    .run();
}

export async function saveConnection(
  env: Env,
  accessEmail: string,
  eightEmail: string,
  token: EightToken,
): Promise<void> {
  await getAccount(env, accessEmail);
  const [accessToken, refreshToken] = await Promise.all([
    seal(token.accessToken, env.TOKEN_KEY),
    seal(token.refreshToken, env.TOKEN_KEY),
  ]);
  await env.DB.prepare(
    `UPDATE accounts SET eight_email = ?, eight_user_id = ?, access_token = ?, refresh_token = ?, token_expires_at = ?,
    cycle_id = NULL, last_command_known = 0, manual_override = 0, override_level = NULL, last_error = NULL
    WHERE access_email = ?`,
  )
    .bind(eightEmail, token.userId, accessToken, refreshToken, token.expiresAt, accessEmail)
    .run();
}

export async function saveToken(env: Env, accessEmail: string, token: EightToken): Promise<void> {
  const [accessToken, refreshToken] = await Promise.all([
    seal(token.accessToken, env.TOKEN_KEY),
    seal(token.refreshToken, env.TOKEN_KEY),
  ]);
  await env.DB.prepare(
    "UPDATE accounts SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE access_email = ?",
  )
    .bind(accessToken, refreshToken, token.expiresAt, accessEmail)
    .run();
}

export async function saveRun(env: Env, account: Account): Promise<void> {
  await env.DB.prepare(
    `UPDATE accounts SET cycle_id = ?, last_commanded_level = ?, last_command_known = ?, manual_override = ?, override_level = ?,
    last_run_at = ?, last_error = NULL WHERE access_email = ?`,
  )
    .bind(
      account.cycleId,
      account.lastCommandedLevel,
      account.lastCommandKnown ? 1 : 0,
      account.manualOverride ? 1 : 0,
      account.overrideLevel,
      new Date().toISOString(),
      account.accessEmail,
    )
    .run();
}

export async function saveRunError(env: Env, email: string, message: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET last_run_at = ?, last_error = ? WHERE access_email = ?")
    .bind(new Date().toISOString(), message.slice(0, 300), email)
    .run();
}

export async function discardCommandState(env: Env, email: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE accounts SET cycle_id = NULL, last_command_known = 0, manual_override = 0, override_level = NULL WHERE access_email = ?",
  )
    .bind(email)
    .run();
}

export async function saveSkippedRun(env: Env, email: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE accounts SET last_run_at = ?, last_error = NULL WHERE access_email = ?",
  )
    .bind(new Date().toISOString(), email)
    .run();
}
