import type { Settings } from "../store";

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function minuteOfDay(value: unknown, name: string): number {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value))
    throw new InputError(`${name} must be HH:mm`);
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3));
  if (hour > 23 || minute > 59) throw new InputError(`${name} must be a valid time`);
  return hour * 60 + minute;
}

export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") throw new InputError("Schedule is required");
  const input = value as Record<string, unknown>;
  const bedtimeMinutes = minuteOfDay(input.bedtime, "Bedtime");
  const wakeMinutes = minuteOfDay(input.wakeTime, "Wake time");
  const duration = (wakeMinutes - bedtimeMinutes + 24 * 60) % (24 * 60);
  if (duration < 4 * 60 || duration > 16 * 60)
    throw new InputError("Sleep duration must be between 4 and 16 hours");
  if (typeof input.timezone !== "string" || input.timezone.length > 80)
    throw new InputError("A timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    throw new InputError("Timezone is invalid");
  }
  if (!input.levels || typeof input.levels !== "object")
    throw new InputError("Three temperature levels are required");
  const levels = input.levels as Record<string, unknown>;
  for (const name of ["early", "middle", "late"]) {
    if (
      typeof levels[name] !== "number" ||
      !Number.isInteger(levels[name]) ||
      levels[name] < -10 ||
      levels[name] > 10
    ) {
      throw new InputError(`${name} temperature must be an integer from -10 to +10`);
    }
  }
  return {
    bedtime: input.bedtime as string,
    wakeTime: input.wakeTime as string,
    timezone: input.timezone,
    levels: {
      early: levels.early as number,
      middle: levels.middle as number,
      late: levels.late as number,
    },
  };
}

export function parseConnection(value: unknown): { email: string; password: string } {
  if (!value || typeof value !== "object") throw new InputError("Eight Sleep login is required");
  const input = value as Record<string, unknown>;
  if (
    typeof input.email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
    input.email.length > 255
  ) {
    throw new InputError("Enter a valid Eight Sleep email address");
  }
  if (
    typeof input.password !== "string" ||
    input.password.length < 1 ||
    input.password.length > 500
  ) {
    throw new InputError("Enter your Eight Sleep password");
  }
  return { email: input.email.trim().toLowerCase(), password: input.password };
}

export function parseControl(value: unknown): "pause" | "resume" {
  if (!value || typeof value !== "object") throw new InputError("Action is required");
  const action = (value as Record<string, unknown>).action;
  if (action !== "pause" && action !== "resume")
    throw new InputError("Action must be pause or resume");
  return action;
}
