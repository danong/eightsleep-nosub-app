import assert from "node:assert/strict";
import test from "node:test";
import {
  nextControlAt,
  previewSchedule,
  reconcileSchedule,
  scheduleTimeline,
  type ScheduleProfile,
  type ScheduleState,
} from "./engine.ts";

const profile: ScheduleProfile = {
  bedtime: "22:00",
  wakeTime: "06:00",
  timezone: "America/New_York",
  levels: { early: 1, middle: -2, late: -5 },
};
const at = (iso: string) => new Date(iso);

test("next control event skips bedtime when preheat and early sleep share a target", () => {
  assert.equal(
    nextControlAt(profile, at("2025-01-15T02:30:00Z")).toISOString(),
    "2025-01-15T04:00:00.000Z",
  );
  assert.equal(
    nextControlAt(profile, at("2025-01-15T03:00:00Z")).toISOString(),
    "2025-01-15T04:00:00.000Z",
  );
});

test("next control event is strictly after exact boundaries", () => {
  assert.equal(
    nextControlAt(profile, at("2025-01-15T04:00:00Z")).toISOString(),
    "2025-01-15T09:00:00.000Z",
  );
  assert.equal(
    nextControlAt(profile, at("2025-01-15T11:00:00Z")).toISOString(),
    "2025-01-16T02:00:00.000Z",
  );
});

test("next control event follows local schedule boundaries across DST changes", () => {
  const fallBack = { ...profile, bedtime: "01:30", wakeTime: "08:00" };
  assert.equal(
    nextControlAt(fallBack, at("2025-11-02T05:45:00Z")).toISOString(),
    "2025-11-02T06:30:00.000Z",
  );

  const springForward = { ...profile, bedtime: "02:30", wakeTime: "10:00" };
  assert.equal(
    nextControlAt(springForward, at("2025-03-09T07:35:00Z")).toISOString(),
    "2025-03-09T08:00:00.000Z",
  );
});

test("overnight schedule selects preheat, bed, middle, late, then off boundaries", () => {
  const checks = [
    ["2025-01-15T02:30:00Z", "preheat", 1], // 21:30 local
    ["2025-01-15T03:00:00Z", "early", 1], // 22:00 local
    ["2025-01-15T04:00:00Z", "middle", -2],
    ["2025-01-15T09:00:00Z", "late", -5], // 04:00 local
    ["2025-01-15T11:00:00Z", "off", null], // 06:00 local
  ] as const;
  for (const [instant, stage, expected] of checks) {
    const result = reconcileSchedule({
      profile,
      now: at(instant),
      observedLevel: 0,
      previous: null,
    });
    assert.equal(result.stage, stage);
    assert.equal(result.desiredLevel, expected);
  }
});

test("each scheduler run reconciles drift and reports next schedule action", () => {
  const result = reconcileSchedule({
    profile,
    now: at("2025-01-15T03:20:00Z"),
    observedLevel: 8,
    previous: null,
  });
  assert.equal(result.commandRequired, true);
  assert.equal(result.command, 1);
  assert.equal(result.nextActionLabel, "Middle stage");
  assert.equal(result.nextActionAt.toISOString(), "2025-01-15T04:00:00.000Z");
});

test("short and long schedules have contiguous positive phases", () => {
  for (const [wakeTime, hours] of [
    ["23:00", 1],
    ["01:00", 3],
    ["16:00", 18],
    ["21:30", 23.5],
    ["22:00", 24],
  ] as const) {
    const testProfile: ScheduleProfile = {
      bedtime: "22:00",
      wakeTime,
      timezone: "UTC",
      levels: { early: 1, middle: 0, late: -1 },
    };
    const timeline = scheduleTimeline(testProfile, at("2025-01-15T00:00:00Z"));
    const sleep = timeline.segments.slice(2, 5);
    assert.deepEqual(
      sleep.map((segment) => segment.key),
      ["early", "middle", "late"],
    );
    for (let index = 0; index < timeline.segments.length - 1; index++)
      assert.equal(timeline.segments[index]!.endAt, timeline.segments[index + 1]!.startAt);
    for (const segment of sleep)
      assert.ok(
        Date.parse(segment.endAt) > Date.parse(segment.startAt),
        `${hours}h ${segment.key}`,
      );
    assert.equal((Date.parse(sleep[2]!.endAt) - Date.parse(sleep[0]!.startAt)) / 3_600_000, hours);
  }
});

test("phase times follow resolved DST wall times", () => {
  const dstProfile = {
    ...profile,
    bedtime: "22:00",
    wakeTime: "06:00",
    timezone: "America/New_York",
  };
  const timeline = scheduleTimeline(dstProfile, at("2025-03-09T04:00:00Z"));
  const sleep = timeline.segments.slice(2, 5);
  assert.equal(sleep[0]!.startAt, "2025-03-09T03:00:00.000Z");
  assert.equal(sleep[2]!.endAt, "2025-03-09T10:00:00.000Z");
});

test("long cycles clip preheat to the prior wake and continue at the next wake", () => {
  for (const [wakeTime, bedStart, bedtime, wake] of [
    ["21:30", "2025-01-14T21:30:00.000Z", "2025-01-14T22:00:00.000Z", "2025-01-15T21:30:00.000Z"],
    ["22:00", "2025-01-14T22:00:00.000Z", "2025-01-14T22:00:00.000Z", "2025-01-15T22:00:00.000Z"],
  ] as const) {
    const longProfile: ScheduleProfile = {
      bedtime: "22:00",
      wakeTime,
      timezone: "UTC",
      levels: { early: 2, middle: 0, late: -2 },
    };
    const timeline = scheduleTimeline(longProfile, at("2025-01-15T00:00:00Z"));
    const preheat = timeline.segments.find((segment) => segment.key === "preheat")!;
    assert.equal(preheat.startAt, bedStart);
    assert.equal(preheat.endAt, bedtime);
    const late = timeline.segments.find((segment) => segment.key === "late")!;
    assert.equal(late.endAt, wake);
    const following = scheduleTimeline(longProfile, at(wake));
    assert.equal(following.cycleId, new Date(Date.parse(bedtime) + 24 * 60 * 60_000).toISOString());
    assert.equal(nextControlAt(longProfile, at("2025-01-15T20:00:00Z")).toISOString(), wake);
  }
});

test("constant-level 24-hour schedule wakes only at the next daily cycle boundary", () => {
  const allDay: ScheduleProfile = {
    bedtime: "22:00",
    wakeTime: "22:00",
    timezone: "UTC",
    levels: { early: 0, middle: 0, late: 0 },
  };
  assert.equal(
    nextControlAt(allDay, at("2025-01-15T00:00:00Z")).toISOString(),
    "2025-01-15T22:00:00.000Z",
  );
  const preview = previewSchedule(allDay, at("2025-01-15T00:00:00Z"));
  assert.equal(preview.stage, "middle");
  const timeline = scheduleTimeline(allDay, at("2025-01-15T00:00:00Z"));
  assert.equal(
    timeline.segments.find((segment) => segment.key === "preheat")!.startAt,
    timeline.segments.find((segment) => segment.key === "preheat")!.endAt,
  );
  assert.equal(timeline.segments[0]!.key, "padding");
  assert.equal(timeline.segments[0]!.level, 0); // prior late level, represented as the actual padding target
});

test("manual level and manual off persist for cycle, then reset at next preheat", () => {
  const initial = reconcileSchedule({
    profile,
    now: at("2025-01-15T03:10:00Z"),
    observedLevel: 1,
    previous: null,
  });
  const levelOverride = reconcileSchedule({
    profile,
    now: at("2025-01-15T03:20:00Z"),
    observedLevel: 4,
    previous: { ...initial.nextState, lastCommandedLevel: 1 },
  });
  assert.equal(levelOverride.manualOverride, true);
  assert.equal(levelOverride.desiredLevel, 4);
  assert.equal(levelOverride.commandRequired, false);

  const offOverride = reconcileSchedule({
    profile,
    now: at("2025-01-15T03:30:00Z"),
    observedLevel: null,
    previous: { ...levelOverride.nextState, lastCommandedLevel: 4 },
  });
  assert.equal(offOverride.manualOverride, true);
  assert.equal(offOverride.desiredLevel, null);
  assert.equal(offOverride.commandRequired, false);

  const daytime = reconcileSchedule({
    profile,
    now: at("2025-01-15T10:00:00Z"),
    observedLevel: null,
    previous: offOverride.nextState,
  });
  assert.equal(daytime.manualOverride, true);
  assert.equal(daytime.desiredLevel, null);
  const nextCycle = reconcileSchedule({
    profile,
    now: at("2025-01-16T02:00:00Z"),
    observedLevel: null,
    previous: daytime.nextState,
  });
  assert.equal(nextCycle.manualOverride, false);
  assert.equal(nextCycle.stage, "preheat");
  assert.equal(nextCycle.commandRequired, true);
});

test("fall-back DST fold chooses the first bedtime occurrence and retains local wake", () => {
  const dstProfile = { ...profile, bedtime: "01:30", wakeTime: "08:00" };
  const cycle = reconcileSchedule({
    profile: dstProfile,
    now: at("2025-11-02T05:45:00Z"),
    observedLevel: 1,
    previous: null,
  });
  assert.equal(cycle.cycleId, "2025-11-02T05:30:00.000Z");
  assert.equal(cycle.stage, "early");
  assert.equal(cycle.nextActionAt.toISOString(), "2025-11-02T06:30:00.000Z");
});

test("spring-forward nonexistent bedtime advances to first valid wall minute", () => {
  const dstProfile = { ...profile, bedtime: "02:30", wakeTime: "10:00" };
  const result = reconcileSchedule({
    profile: dstProfile,
    now: at("2025-03-09T07:35:00Z"),
    observedLevel: 1,
    previous: null,
  });
  assert.equal(result.cycleId, "2025-03-09T07:00:00.000Z");
  assert.equal(result.stage, "early");
});

test("short spring-forward interval keeps three monotonic phases", () => {
  const shortDstProfile = { ...profile, bedtime: "01:00", wakeTime: "05:00" };
  const result = previewSchedule(shortDstProfile, at("2025-03-09T07:30:00Z"));
  assert.equal(result.stage, "middle");
  assert.equal(result.nextActionLabel, "Late stage");
  assert.equal(result.nextActionAt.toISOString(), "2025-03-09T08:00:00.000Z");
});

test("wake has a concrete off transition and does not issue a stage write", () => {
  const previous: ScheduleState = {
    cycleId: "2025-01-15T03:00:00.000Z",
    lastCommandedLevel: -5,
    manualOverride: false,
    overrideLevel: -5,
  };
  const result = reconcileSchedule({
    profile,
    now: at("2025-01-15T11:00:00Z"),
    observedLevel: -5,
    previous,
  });
  assert.equal(result.stage, "off");
  assert.equal(result.desiredLevel, null);
  assert.equal(result.commandRequired, true);
  assert.equal(result.command, null);
  assert.equal(result.nextActionAt.toISOString(), "2025-01-16T02:00:00.000Z");
});

test("wake expires sleep override, then daytime manual changes persist until preheat", () => {
  const prior: ScheduleState = {
    cycleId: "2025-01-15T03:00:00.000Z",
    lastCommandedLevel: 1,
    manualOverride: true,
    overrideLevel: 4,
  };
  const wake = reconcileSchedule({
    profile,
    now: at("2025-01-15T11:00:00Z"),
    observedLevel: 4,
    previous: prior,
  });
  assert.equal(wake.manualOverride, false);
  assert.equal(wake.desiredLevel, null);
  assert.equal(wake.commandRequired, true);
  assert.equal(wake.nextState.lastCommandedLevel, null);

  const daytimeChange = reconcileSchedule({
    profile,
    now: at("2025-01-15T12:00:00Z"),
    observedLevel: 3,
    previous: wake.nextState,
  });
  assert.equal(daytimeChange.manualOverride, true);
  assert.equal(daytimeChange.desiredLevel, 3);
  assert.equal(daytimeChange.commandRequired, false);
});
