import assert from "node:assert/strict";
import test from "node:test";
import { immediateActionAt, retrySchedule } from "./scheduler-timing.ts";

test("schedule mutations request reconciliation within one second", () => {
  assert.equal(immediateActionAt(10_000), 11_000);
});

test("retry deadlines replace an already-due action to preserve backoff", () => {
  const retry = retrySchedule(0, 20_000, 19_000, 80_000);
  assert.deepEqual(retry, {
    failureCount: 1,
    retryAt: 50_000,
    nextActionAt: 80_000,
  });
});

test("later failures increase retry delay and retain a future schedule action", () => {
  const retry = retrySchedule(1, 20_000, 90_000, 100_000);
  assert.deepEqual(retry, {
    failureCount: 2,
    retryAt: 140_000,
    nextActionAt: 90_000,
  });
});
