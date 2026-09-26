const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
export const IMMEDIATE_ACTION_DELAY_MS = 1_000;

export function immediateActionAt(now: number): number {
  return now + IMMEDIATE_ACTION_DELAY_MS;
}

export function retrySchedule(
  failureCount: number,
  now: number,
  nextActionAt: number | null,
  nextScheduledAt: number,
): { failureCount: number; retryAt: number; nextActionAt: number } {
  const nextFailureCount = failureCount + 1;
  const delay = RETRY_DELAYS_MS[Math.min(nextFailureCount - 1, RETRY_DELAYS_MS.length - 1)]!;
  return {
    failureCount: nextFailureCount,
    retryAt: now + delay,
    // Move an expired action beyond now so the retry deadline controls alarm
    // scheduling instead of the old due timestamp causing 1 second alarms.
    nextActionAt: nextActionAt === null || nextActionAt <= now ? nextScheduledAt : nextActionAt,
  };
}
