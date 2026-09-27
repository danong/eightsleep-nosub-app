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

test("accepts all valid clock pairs and rejects invalid times, zones, and levels", () => {
  assert.throws(() => parseSettings({ ...valid, bedtime: "25:00" }));
  for (const [bedtime, wakeTime] of [
    ["22:00", "23:00"],
    ["22:00", "01:00"],
    ["22:00", "16:00"],
    ["22:00", "21:30"],
    ["22:00", "22:00"],
  ])
    assert.equal(parseSettings({ ...valid, bedtime, wakeTime }).wakeTime, wakeTime);
  assert.throws(() => parseSettings({ ...valid, timezone: "Invalid/Zone" }));
  assert.throws(() => parseSettings({ ...valid, levels: { ...valid.levels, late: 11 } }));
});
