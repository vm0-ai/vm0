// ---------------------------------------------------------------------------
// Shared cron / one-time trigger utilities
// ---------------------------------------------------------------------------

import { getGmtOffset } from "@vm0/core/timezone";

import { now, nowDate } from "../../lib/time.ts";

type AutomationTimeOption =
  | "every-weekday"
  | "every-day"
  | "every-week"
  | "every-month"
  | "loop";

export type CronTimeOption = Exclude<AutomationTimeOption, "loop">;

/** Discriminated union for automation creation/update request body. */
export type AutomationFormBody = {
  agentId: string;
  name: string;
  timezone: string;
  prompt: string;
  description?: string;
  enabled?: boolean;
  modelProviderId?: string | null;
  selectedModel?: string | null;
} & (
  | { cronExpression: string }
  | { atTime: string }
  | { intervalSeconds: number }
);

// ---------------------------------------------------------------------------
// One-time trigger helpers
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
  return new Date(y, mo - 1, d, h, m).getTime() <= now();
}

/** Today's date in the local timezone formatted as YYYY-MM-DD. */
export function getTodayDateLocal(): string {
  const today = nowDate();
  const y = today.getFullYear();
  const mo = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

// ---------------------------------------------------------------------------
// Common timezones for automation form selectors
// ---------------------------------------------------------------------------

export const COMMON_TIMEZONES = [
  "Etc/UTC",
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

/** Human-readable display labels for COMMON_TIMEZONES entries. Falls back to the IANA string for unlisted values. */
const TIMEZONE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "Etc/UTC": "UTC",
  "America/New_York": "Eastern Time (ET)",
  "America/Chicago": "Central Time (CT)",
  "America/Denver": "Mountain Time (MT)",
  "America/Los_Angeles": "Pacific Time (PT)",
  "America/Anchorage": "Alaska Time (AKT)",
  "Pacific/Honolulu": "Hawaii Time (HST)",
  "America/Toronto": "Toronto (ET)",
  "America/Vancouver": "Vancouver (PT)",
  "America/Sao_Paulo": "Brasília Time (BRT)",
  "Europe/London": "London (GMT/BST)",
  "Europe/Berlin": "Central European Time (CET)",
  "Europe/Paris": "Paris (CET)",
  "Europe/Moscow": "Moscow Time (MSK)",
  "Asia/Dubai": "Gulf Standard Time (GST)",
  "Asia/Kolkata": "India Standard Time (IST)",
  "Asia/Shanghai": "China Standard Time (CST)",
  "Asia/Tokyo": "Japan Standard Time (JST)",
  "Asia/Seoul": "Korea Standard Time (KST)",
  "Asia/Singapore": "Singapore Time (SGT)",
  "Australia/Sydney": "Australian Eastern Time (AET)",
  "Pacific/Auckland": "New Zealand Time (NZST)",
});

/** Returns a human-readable label for an IANA timezone string, prefixed with GMT offset. */
export function getTimezoneLabel(iana: string): string {
  const offset = getGmtOffset(iana);
  const name = TIMEZONE_LABELS[iana] ?? iana.replace(/_/g, " ");
  return `(${offset}) ${name}`;
}

export function cronUtcToLocalTime(
  utcHour: number,
  utcMinute: number,
  timezone: string,
): { hour: number; minute: number } {
  return cronTimeInTimezone(utcHour, utcMinute, "UTC", timezone);
}

function datePart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return (
    parts.find((p) => {
      return p.type === type;
    })?.value ?? "0"
  );
}

// Interpret a cron wall-clock time in its trigger timezone, then format it in
// the user's display timezone.
function timezoneOffsetMinutes(timezone: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).formatToParts(new Date(instantMs));
  const wallTimeAsUtc = Date.UTC(
    Number(datePart(parts, "year")),
    Number(datePart(parts, "month")) - 1,
    Number(datePart(parts, "day")),
    Number(datePart(parts, "hour")),
    Number(datePart(parts, "minute")),
    Number(datePart(parts, "second")),
  );
  return (wallTimeAsUtc - instantMs) / 60_000;
}

function zonedWallTimeToUtc(
  timezone: string,
  wallTime: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
): Date {
  const utcGuess = Date.UTC(
    wallTime.year,
    wallTime.month - 1,
    wallTime.day,
    wallTime.hour,
    wallTime.minute,
    0,
    0,
  );
  const firstOffset = timezoneOffsetMinutes(timezone, utcGuess);
  const firstInstant = utcGuess - firstOffset * 60_000;
  const secondOffset = timezoneOffsetMinutes(timezone, firstInstant);
  return new Date(utcGuess - secondOffset * 60_000);
}

export function cronTimeInTimezone(
  hour: number,
  minute: number,
  sourceTimezone: string,
  displayTimezone: string,
): { hour: number; minute: number } {
  if (sourceTimezone === displayTimezone) {
    return { hour, minute };
  }
  const sourceDateParts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: sourceTimezone,
  }).formatToParts(nowDate());
  const d = zonedWallTimeToUtc(sourceTimezone, {
    year: Number(datePart(sourceDateParts, "year")),
    month: Number(datePart(sourceDateParts, "month")),
    day: Number(datePart(sourceDateParts, "day")),
    hour,
    minute,
  });
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: displayTimezone,
  }).formatToParts(d);
  return {
    hour: Number(
      parts.find((p) => {
        return p.type === "hour";
      })?.value ?? hour,
    ),
    minute: Number(
      parts.find((p) => {
        return p.type === "minute";
      })?.value ?? minute,
    ),
  };
}

export function atTimeInTimezone(
  isoTime: string,
  timezone: string,
): { date: string; hour: number; minute: number } {
  const d = new Date(isoTime);
  const tz = timezone || "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).formatToParts(d);
  const get = (type: string) => {
    return (
      parts.find((p) => {
        return p.type === type;
      })?.value ?? "00"
    );
  };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
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
