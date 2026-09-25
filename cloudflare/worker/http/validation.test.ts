import assert from "node:assert/strict";
import test from "node:test";
import { parseSettings } from "./validation.ts";

const valid = {
  bedtime: "23:00",
  wakeTime: "06:00",
  timezone: "America/Los_Angeles",
  levels: { early: -1, middle: 0, late: 1 },
};

test("accepts an overnight schedule with the three UI levels", () => {
  assert.deepEqual(parseSettings(valid), valid);
});

test("rejects invalid times, zones, durations, and out of range levels", () => {
  assert.throws(() => parseSettings({ ...valid, bedtime: "25:00" }));
  assert.throws(() => parseSettings({ ...valid, wakeTime: "01:00" }));
  assert.throws(() => parseSettings({ ...valid, timezone: "Invalid/Zone" }));
  assert.throws(() => parseSettings({ ...valid, levels: { ...valid.levels, late: 11 } }));
});
