export type ActivityOutcome = "adjusted" | "unchanged" | "manual_override" | "failed";
export interface ActivityEntry {
  at: string;
  observedAvailable: boolean;
  observedLevel: number | null;
  scheduledLevel: number | null;
  commandLevel: number | null;
  commandAttempted: boolean;
  commandIssued: boolean;
  manualOverride: boolean;
  outcome: ActivityOutcome;
  error?: string;
}
export const MAX_ACTIVITY_ENTRIES = 100;

/** Add one run result and keep the newest bounded history in memory/storage. */
export function appendActivity(
  entries: ActivityEntry[] | undefined,
  entry: ActivityEntry,
): ActivityEntry[] {
  return [entry, ...(entries ?? [])].slice(0, MAX_ACTIVITY_ENTRIES);
}

export function buildActivityEntry(input: {
  at: string;
  observedAvailable: boolean;
  observedLevel: number | null;
  scheduledLevel: number | null;
  commandLevel: number | null;
  commandAttempted: boolean;
  commandIssued: boolean;
  detectedManualOverride: boolean;
  failed?: boolean;
  error?: string;
}): ActivityEntry {
  const outcome = input.failed
    ? "failed"
    : input.detectedManualOverride
      ? "manual_override"
      : input.commandIssued
        ? "adjusted"
        : "unchanged";
  return {
    at: input.at,
    observedAvailable: input.observedAvailable,
    observedLevel: input.observedLevel,
    scheduledLevel: input.scheduledLevel,
    commandLevel: input.commandLevel,
    commandAttempted: input.commandAttempted,
    commandIssued: input.commandIssued,
    manualOverride: input.detectedManualOverride,
    outcome,
    ...(input.error ? { error: input.error } : {}),
  };
}
