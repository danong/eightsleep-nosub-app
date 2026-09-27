import assert from "node:assert/strict";
import test from "node:test";
import {
  appendActivity,
  buildActivityEntry,
  MAX_ACTIVITY_ENTRIES,
  type ActivityEntry,
} from "./activity.ts";

test("activity is newest first and bounded to the most recent entries", () => {
  let entries: ActivityEntry[] | undefined;
  for (let index = 0; index < MAX_ACTIVITY_ENTRIES + 5; index++) {
    entries = appendActivity(entries, {
      at: new Date(index * 1_000).toISOString(),
      observedAvailable: true,
      observedLevel: index,
      scheduledLevel: 0,
      commandLevel: null,
      commandAttempted: false,
      commandIssued: false,
      manualOverride: false,
      outcome: "unchanged",
    });
  }
  assert.ok(entries);
  assert.equal(entries.length, MAX_ACTIVITY_ENTRIES);
  assert.equal(entries[0]?.observedLevel, MAX_ACTIVITY_ENTRIES + 4);
  assert.equal(entries.at(-1)?.observedLevel, 5);
});

test("activity builder distinguishes unchanged, manual override, successful and failed writes", () => {
  const base = {
    at: "2026-09-27T12:00:00.000Z",
    observedAvailable: true,
    observedLevel: 2,
    scheduledLevel: 0,
    commandLevel: 2,
    detectedManualOverride: false,
  };
  assert.equal(
    buildActivityEntry({ ...base, commandAttempted: false, commandIssued: false }).outcome,
    "unchanged",
  );
  const manual = buildActivityEntry({
    ...base,
    commandLevel: null,
    detectedManualOverride: true,
    commandAttempted: false,
    commandIssued: false,
  });
  assert.equal(manual.outcome, "manual_override");
  assert.equal(manual.manualOverride, true);
  const adjusted = buildActivityEntry({
    ...base,
    commandAttempted: true,
    commandIssued: true,
  });
  assert.equal(adjusted.outcome, "adjusted");
  assert.equal(adjusted.commandIssued, true);
  const failed = buildActivityEntry({
    ...base,
    commandAttempted: true,
    commandIssued: false,
    failed: true,
    error: "Scheduler run failed",
  });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.commandAttempted, true);
  assert.equal(failed.commandIssued, false);
  const writeCompletedButStateSaveFailed = buildActivityEntry({
    ...base,
    commandAttempted: true,
    commandIssued: true,
    failed: true,
  });
  assert.equal(writeCompletedButStateSaveFailed.outcome, "failed");
  assert.equal(writeCompletedButStateSaveFailed.commandIssued, true);
  const unavailable = buildActivityEntry({
    ...base,
    observedAvailable: false,
    observedLevel: null,
    commandAttempted: false,
    commandIssued: false,
    failed: true,
  });
  const observedOff = buildActivityEntry({
    ...base,
    observedAvailable: true,
    observedLevel: null,
    commandAttempted: false,
    commandIssued: false,
  });
  assert.equal(unavailable.observedAvailable, false);
  assert.equal(unavailable.observedLevel, null);
  assert.equal(observedOff.observedAvailable, true);
  assert.equal(observedOff.observedLevel, null);
});
