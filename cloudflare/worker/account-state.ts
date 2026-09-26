import type { EightToken } from "./eight";
import { seal, unseal } from "./secrets";

/** User-editable schedule data. The scheduler treats this as an opaque profile. */
export interface Settings {
  bedtime: string;
  wakeTime: string;
  timezone: string;
  levels: { early: number; middle: number; late: number };
}

export interface AccountState {
  email: string;
  eightEmail: string | null;
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: number | null;
  userId: string | null;
  settings: Settings;
  configured: boolean;
  paused: boolean;
  cycleId: string | null;
  lastCommandedLevel: number | null;
  commandKnown: boolean;
  manualOverride: boolean;
  overrideLevel: number | null;
  lastRunAt: string | null;
  lastError: string | null;
  retryAt: number | null;
  failureCount: number;
  nextActionAt: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  bedtime: "22:00",
  wakeTime: "07:00",
  timezone: "America/Los_Angeles",
  levels: { early: 0, middle: 0, late: 0 },
};

export function newAccount(email: string): AccountState {
  return {
    email,
    eightEmail: null,
    encryptedAccessToken: null,
    encryptedRefreshToken: null,
    tokenExpiresAt: null,
    userId: null,
    settings: structuredClone(DEFAULT_SETTINGS),
    configured: false,
    paused: false,
    cycleId: null,
    lastCommandedLevel: null,
    commandKnown: false,
    manualOverride: false,
    overrideLevel: null,
    lastRunAt: null,
    lastError: null,
    retryAt: null,
    failureCount: 0,
    nextActionAt: null,
  };
}

export async function readToken(state: AccountState, key: string): Promise<EightToken | null> {
  if (
    !state.userId ||
    !state.encryptedAccessToken ||
    !state.encryptedRefreshToken ||
    !state.tokenExpiresAt
  )
    return null;
  return {
    userId: state.userId,
    accessToken: await unseal(state.encryptedAccessToken, key),
    refreshToken: await unseal(state.encryptedRefreshToken, key),
    expiresAt: state.tokenExpiresAt,
  };
}

export async function writeToken(
  state: AccountState,
  token: EightToken,
  key: string,
): Promise<void> {
  const [access, refresh] = await Promise.all([
    seal(token.accessToken, key),
    seal(token.refreshToken, key),
  ]);
  state.userId = token.userId;
  state.encryptedAccessToken = access;
  state.encryptedRefreshToken = refresh;
  state.tokenExpiresAt = token.expiresAt;
}
