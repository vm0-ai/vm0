// ---------------------------------------------------------------------------
// Shared cron / one-time schedule utilities
// ---------------------------------------------------------------------------

export type ScheduleTimeOption =
  | "every-weekday"
  | "every-day"
  | "every-week"
  | "every-month"
  | "loop";

export type CronTimeOption = Exclude<ScheduleTimeOption, "loop">;

/** Discriminated union for schedule creation/update request body. */
export type ScheduleBody = {
  composeId: string;
  name: string;
  timezone: string;
  prompt: string;
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

/** Tomorrow's date in the local timezone formatted as YYYY-MM-DD. */
export function getTomorrowDateLocal(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const y = tomorrow.getFullYear();
  const mo = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const day = String(tomorrow.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** Today's date in the local timezone formatted as YYYY-MM-DD. */
export function getTodayDateLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

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
