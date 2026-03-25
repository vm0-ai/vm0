// ---------------------------------------------------------------------------
// Shared cron / one-time schedule utilities
// ---------------------------------------------------------------------------

type ScheduleTimeOption =
  | "every-weekday"
  | "every-day"
  | "every-week"
  | "every-month"
  | "loop";

export type CronTimeOption = Exclude<ScheduleTimeOption, "loop">;

/** Discriminated union for schedule creation/update request body. */
export type ScheduleBody = {
  agentId: string;
  name: string;
  timezone: string;
  prompt: string;
  description?: string;
  enabled?: boolean;
} & (
  | { cronExpression: string }
  | { atTime: string }
  | { intervalSeconds: number }
);

// ---------------------------------------------------------------------------
// One-time schedule helpers
// ---------------------------------------------------------------------------

/** Build an ISO datetime string from local date + hour + minute. */
export function buildAtTime(
  date: string,
  hour: string,
  minute: string,
): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const h = Number.parseInt(hour, 10);
  const m = Number.parseInt(minute, 10);
  return new Date(y, mo - 1, d, h, m).toISOString();
}

/** Return true when the given local date + hour + minute is in the past. */
export function isAtTimePast(
  date: string,
  hour: string,
  minute: string,
): boolean {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const h = Number.parseInt(hour, 10);
  const m = Number.parseInt(minute, 10);
  return new Date(y, mo - 1, d, h, m).getTime() <= Date.now();
}

/** Today's date in the local timezone formatted as YYYY-MM-DD. */
export function getTodayDateLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

// ---------------------------------------------------------------------------
// Common timezones for schedule selectors
// ---------------------------------------------------------------------------

export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

export function buildCronExpression(opts: {
  timeOption: CronTimeOption;
  hour: string;
  minute?: string;
  dayOfWeek?: string;
  dayOfMonth?: string;
}): string {
  const h = Number.parseInt(opts.hour, 10);
  const m = opts.minute !== undefined ? Number.parseInt(opts.minute, 10) : 0;
  switch (opts.timeOption) {
    case "every-weekday": {
      return `${String(m)} ${String(h)} * * 1-5`;
    }
    case "every-day": {
      return `${String(m)} ${String(h)} * * *`;
    }
    case "every-week": {
      const dow = opts.dayOfWeek ?? "1";
      return `${String(m)} ${String(h)} * * ${dow}`;
    }
    case "every-month": {
      const dom = opts.dayOfMonth ?? "1";
      return `${String(m)} ${String(h)} ${dom} * *`;
    }
  }
}
