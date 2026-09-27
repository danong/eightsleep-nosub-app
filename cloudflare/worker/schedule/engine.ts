/** Pure schedule calculation and reconciliation for one side of an Eight Sleep bed. */

export interface ScheduleProfile {
  bedtime: string;
  wakeTime: string;
  timezone: string;
  levels: { early: number; middle: number; late: number };
}

export type ScheduleStage = "preheat" | "early" | "middle" | "late" | "off";
export type HeatingLevel = number | null;

export interface ScheduleState {
  cycleId: string;
  /** Last value successfully sent to the bed. Null means an off command. */
  lastCommandedLevel: HeatingLevel;
  /** Manual intervention inferred from a difference between commanded and observed. */
  manualOverride: boolean;
  overrideLevel: HeatingLevel;
}

export interface ReconcileInput {
  profile: ScheduleProfile;
  now: Date;
  /** Current bed setting. Null means heating is off. */
  observedLevel: HeatingLevel;
  previous: ScheduleState | null;
}

export interface ReconcileResult {
  cycleId: string;
  stage: ScheduleStage;
  desiredLevel: HeatingLevel;
  /** Null means no API write is needed. Null desiredLevel is an off command when command is also null? See commandRequired. */
  command: HeatingLevel;
  commandRequired: boolean;
  manualOverride: boolean;
  nextState: ScheduleState;
  nextActionAt: Date;
  nextActionLabel: string;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}
interface Cycle {
  id: string;
  preheat: number;
  bed: number;
  middle: number;
  late: number;
  wake: number;
  nextPreheat: number;
}
export interface TimelineSegment {
  key: "preheat" | "early" | "middle" | "late" | "off" | "padding";
  label: string;
  startAt: string;
  endAt: string;
  level: HeatingLevel;
}
export interface ScheduleTimeline {
  timezone: string;
  cycleId: string;
  segments: TimelineSegment[];
}
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const wallTimeCache = new Map<string, number>();

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid schedule time: ${value}`);
  const hour = Number(match[1]),
    minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid schedule time: ${value}`);
  return { hour, minute };
}

function partsAt(epoch: number, timezone: string): WallTime {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(epoch));
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function wallStamp(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

function dateShift(wall: WallTime, days: number): WallTime {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { ...wall, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Resolve a local wall time, choosing the first occurrence in a fall-back fold.
 * For a nonexistent spring-forward time, move to the first valid minute afterward.
 */
function resolveWall(wall: WallTime, timezone: string): number {
  const nominal = wallStamp(wall);
  const cacheKey = `${timezone}:${nominal}`;
  const cached = wallTimeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const remember = (epoch: number) => {
    wallTimeCache.set(cacheKey, epoch);
    if (wallTimeCache.size > 256) wallTimeCache.delete(wallTimeCache.keys().next().value!);
    return epoch;
  };
  const offsets = new Set<number>();
  // Timezone offsets near the target are stable except for a transition. A
  // few samples cover both sides of a DST boundary without hundreds of Intl calls.
  for (const delta of [-36 * HOUR, -12 * HOUR, 0, 12 * HOUR, 36 * HOUR]) {
    const sample = nominal + delta;
    const local = partsAt(sample, timezone);
    offsets.add(wallStamp(local) - sample);
  }
  const matches = [...offsets]
    .map((offset) => nominal - offset)
    .filter((candidate) => {
      const local = partsAt(candidate, timezone);
      return (
        local.year === wall.year &&
        local.month === wall.month &&
        local.day === wall.day &&
        local.hour === wall.hour &&
        local.minute === wall.minute
      );
    })
    .sort((a, b) => a - b);
  if (matches.length) return remember(matches[0]!);

  // For a spring-forward gap, find the first real minute whose wall clock is
  // after the missing time. DST gaps are far narrower than the sample window.
  const bounds = [...offsets].map((offset) => nominal - offset).sort((a, b) => a - b);
  let low = bounds[0]!,
    high = bounds[bounds.length - 1]!;
  const highWall = partsAt(high, timezone);
  if (wallStamp(highWall) >= nominal) {
    while (high - low > MINUTE) {
      const mid = Math.floor((low + high) / (2 * MINUTE)) * MINUTE;
      if (wallStamp(partsAt(mid, timezone)) >= nominal) high = mid;
      else low = mid;
    }
    return remember(high);
  }
  throw new Error(`Could not resolve local time in ${timezone}`);
}

function cycleForDate(date: WallTime, profile: ScheduleProfile): Cycle {
  const bedClock = parseTime(profile.bedtime),
    wakeClock = parseTime(profile.wakeTime);
  const bedWall = { ...date, ...bedClock };
  const wakeDate =
    wakeClock.hour * 60 + wakeClock.minute <= bedClock.hour * 60 + bedClock.minute
      ? dateShift(date, 1)
      : date;
  const wakeWall = { ...wakeDate, ...wakeClock };
  const bed = resolveWall(bedWall, profile.timezone);
  const wake = resolveWall(wakeWall, profile.timezone);
  const nextBed = resolveWall({ ...dateShift(date, 1), ...bedClock }, profile.timezone);
  const previousWakeDate =
    wakeClock.hour * 60 + wakeClock.minute <= bedClock.hour * 60 + bedClock.minute
      ? date
      : dateShift(date, -1);
  const previousWake = resolveWall({ ...previousWakeDate, ...wakeClock }, profile.timezone);
  const duration = wake - bed;
  // Preserve the familiar one-hour early and two-hour late phases where
  // possible. Short schedules divide the available sleep into three phases;
  // the middle phase absorbs extra time on long schedules.
  const earlyDuration = Math.min(HOUR, duration / 3);
  const lateDuration = Math.min(2 * HOUR, duration / 3);
  const middle = bed + earlyDuration;
  const late = wake - lateDuration;
  return {
    id: new Date(bed).toISOString(),
    bed,
    preheat: Math.max(bed - HOUR, previousWake),
    middle,
    late,
    wake,
    nextPreheat: Math.max(nextBed - HOUR, wake),
  };
}

/** Display the selected cycle with one hour of real scheduled context either side. */
export function scheduleTimeline(profile: ScheduleProfile, now: Date): ScheduleTimeline {
  let cycle = findCycle(now, profile);
  if (now.getTime() > cycle.wake + HOUR) {
    cycle = cycleForDate(dateShift(partsAt(cycle.bed, profile.timezone), 1), profile);
  }
  const stamp = (instant: number) => new Date(instant).toISOString();
  const padStart = cycle.preheat - HOUR;
  const padEnd = cycle.wake + HOUR;
  const local = partsAt(cycle.bed, profile.timezone);
  const nearby = [-2, -1, 0, 1, 2]
    .map((offset) => cycleForDate(dateShift(local, offset), profile))
    .flatMap((item) => [item.preheat, item.bed, item.middle, item.late, item.wake])
    .filter((instant) => instant > padStart && instant < padEnd);
  const boundaries = [...new Set([padStart, ...nearby, padEnd])].sort((a, b) => a - b);
  const padding: TimelineSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    if (end <= cycle.preheat || start >= cycle.wake) {
      const sample = start + (end - start) / 2;
      const actualCycle = findCycle(new Date(sample), profile);
      const level = stageAt(sample, actualCycle, profile).level;
      padding.push({
        key: "padding",
        label: level === null ? "Off" : "Scheduled",
        startAt: stamp(start),
        endAt: stamp(end),
        level,
      });
    }
  }
  return {
    timezone: profile.timezone,
    cycleId: cycle.id,
    segments: [
      ...padding.filter((segment) => Date.parse(segment.endAt) <= cycle.preheat),
      {
        key: "preheat",
        label: "Preheat",
        startAt: stamp(cycle.preheat),
        endAt: stamp(cycle.bed),
        level: profile.levels.early,
      },
      {
        key: "early",
        label: "Early sleep",
        startAt: stamp(cycle.bed),
        endAt: stamp(cycle.middle),
        level: profile.levels.early,
      },
      {
        key: "middle",
        label: "Mid sleep",
        startAt: stamp(cycle.middle),
        endAt: stamp(cycle.late),
        level: profile.levels.middle,
      },
      {
        key: "late",
        label: "Late sleep",
        startAt: stamp(cycle.late),
        endAt: stamp(cycle.wake),
        level: profile.levels.late,
      },
      ...padding.filter((segment) => Date.parse(segment.startAt) >= cycle.wake),
    ],
  };
}

function findCycle(now: Date, profile: ScheduleProfile): Cycle {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid current time");
  // Validate timezone before evaluating dates.
  new Intl.DateTimeFormat("en-US", { timeZone: profile.timezone });
  const local = partsAt(now.getTime(), profile.timezone);
  const candidates = [-1, 0, 1].map((n) => cycleForDate(dateShift(local, n), profile));
  // Keep the most recently started cycle through its daytime off period. Its
  // manual override remains in force until the following preheat boundary.
  return (
    candidates
      .filter((cycle) => cycle.preheat <= now.getTime())
      .sort((a, b) => b.preheat - a.preheat)[0] ??
    candidates.sort((a, b) => a.preheat - b.preheat)[0]!
  );
}

/**
 * Return the next instant at which the scheduled bed target actually changes.
 *
 * Keep this API expressed in terms of control transitions rather than stage
 * names. The current schedule is represented as a set of candidate boundaries;
 * A boundary is actionable when the target changes, or when it starts a new
 * cycle. The cycle-start exception resets manual overrides even for continuous
 * all-day targets. Other same-target phase boundaries, such as bedtime, are
 * skipped.
 */
export function nextControlAt(profile: ScheduleProfile, now: Date): Date {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid current time");
  new Intl.DateTimeFormat("en-US", { timeZone: profile.timezone });
  const local = partsAt(now.getTime(), profile.timezone);
  const boundaries = [-1, 0, 1, 2]
    .map((day) => cycleForDate(dateShift(local, day), profile))
    .flatMap((cycle) => [cycle.preheat, cycle.bed, cycle.middle, cycle.late, cycle.wake])
    .filter((instant) => instant > now.getTime())
    .sort((a, b) => a - b);

  for (const instant of boundaries) {
    const beforeCycle = findCycle(new Date(instant - 1), profile);
    const afterCycle = findCycle(new Date(instant), profile);
    const before = stageAt(instant - 1, beforeCycle, profile).level;
    const after = stageAt(instant, afterCycle, profile).level;
    if (before !== after || (beforeCycle.id !== afterCycle.id && instant === afterCycle.preheat))
      return new Date(instant);
  }
  // Keep a daily cycle-start reconciliation even when the target is constant.
  const maintenance = boundaries.find((instant) => {
    if (instant <= now.getTime()) return false;
    const afterCycle = findCycle(new Date(instant), profile);
    return instant === afterCycle.preheat;
  });
  if (maintenance !== undefined) return new Date(maintenance);
  throw new Error("Could not find next schedule control event");
}

function stageAt(
  now: number,
  cycle: Cycle,
  profile: ScheduleProfile,
): { stage: ScheduleStage; level: HeatingLevel; nextAt: number; nextLabel: string } {
  if (now < cycle.preheat)
    return { stage: "off", level: null, nextAt: cycle.preheat, nextLabel: "Preheat" };
  if (now < cycle.bed)
    return {
      stage: "preheat",
      level: profile.levels.early,
      nextAt: cycle.bed,
      nextLabel: "Bedtime",
    };
  if (now < cycle.middle)
    return {
      stage: "early",
      level: profile.levels.early,
      nextAt: cycle.middle,
      nextLabel: "Middle stage",
    };
  if (now < cycle.late)
    return {
      stage: "middle",
      level: profile.levels.middle,
      nextAt: cycle.late,
      nextLabel: "Late stage",
    };
  if (now < cycle.wake)
    return { stage: "late", level: profile.levels.late, nextAt: cycle.wake, nextLabel: "Wake" };
  return { stage: "off", level: null, nextAt: cycle.nextPreheat, nextLabel: "Next preheat" };
}

/** Return schedule display data without reading bed state or calculating a command. */
export function previewSchedule(
  profile: ScheduleProfile,
  now: Date,
): {
  cycleId: string;
  stage: ScheduleStage;
  desiredLevel: HeatingLevel;
  nextActionAt: Date;
  nextActionLabel: string;
} {
  const cycle = findCycle(now, profile);
  const { stage, level, nextAt, nextLabel } = stageAt(now.getTime(), cycle, profile);
  return {
    cycleId: cycle.id,
    stage,
    desiredLevel: level,
    nextActionAt: new Date(nextAt),
    nextActionLabel: nextLabel,
  };
}

/** Determine the target when reconciliation runs and preserve detected manual
 * changes until the next cycle begins. A caller should persist `nextState`.
 */
export function reconcileSchedule(input: ReconcileInput): ReconcileResult {
  const cycle = findCycle(input.now, input.profile);
  const {
    stage,
    level: scheduledLevel,
    nextAt,
    nextLabel,
  } = stageAt(input.now.getTime(), cycle, input.profile);
  const sameCycle = input.previous?.cycleId === cycle.id && input.now.getTime() >= cycle.preheat;
  const beforeWake = input.now.getTime() < cycle.wake;
  // Sleep-period overrides expire at wake, when the scheduled off command wins.
  // A later daytime adjustment is recognized after an off command has been sent.
  let manualOverride = sameCycle && beforeWake && input.previous!.manualOverride;
  let overrideLevel = manualOverride ? input.previous!.overrideLevel : scheduledLevel;

  const changedDuringSleep =
    sameCycle && beforeWake && input.previous!.lastCommandedLevel !== input.observedLevel;
  const changedAfterWake =
    sameCycle &&
    !beforeWake &&
    input.previous!.lastCommandedLevel === null &&
    input.observedLevel !== null;
  if (changedDuringSleep || changedAfterWake) {
    manualOverride = true;
    overrideLevel = input.observedLevel;
  }
  const desiredLevel = manualOverride ? overrideLevel : scheduledLevel;
  const commandRequired = input.observedLevel !== desiredLevel;
  const command = commandRequired ? desiredLevel : null;
  const lastCommandedLevel = manualOverride ? input.previous!.lastCommandedLevel : desiredLevel;
  return {
    cycleId: cycle.id,
    stage,
    desiredLevel,
    command,
    commandRequired,
    manualOverride,
    nextState: { cycleId: cycle.id, lastCommandedLevel, manualOverride, overrideLevel },
    nextActionAt: new Date(nextAt),
    nextActionLabel: nextLabel,
  };
}
