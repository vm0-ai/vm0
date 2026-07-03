import type { UsageRecordRange } from "@vm0/api-contracts/contracts/zero-usage-record";

import { nowDate } from "../external/time";

export type UsageRangeArg = UsageRecordRange | "all";

export interface UsagePeriod {
  readonly start: Date;
  readonly end: Date;
}

const DAY_MS = 86_400_000;

interface TimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function partsInTz(date: Date, tz: string): TimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    return Number(
      parts.find((part) => {
        return part.type === type;
      })?.value ?? 0,
    );
  };

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function startOfCalendarDateInTz(isoDate: string, tz: string): Date {
  const [yearPart, monthPart, dayPart] = isoDate.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;

  for (let i = 0; i < 4; i++) {
    const parts = partsInTz(new Date(guess), tz);
    const actual = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const delta = actual - target;
    if (delta === 0) {
      return new Date(guess);
    }
    guess -= delta;
  }

  return new Date(guess);
}

function calendarDateInTz(date: Date, tz: string): string {
  const parts = partsInTz(date, tz);
  return [
    parts.year.toString().padStart(4, "0"),
    parts.month.toString().padStart(2, "0"),
    parts.day.toString().padStart(2, "0"),
  ].join("-");
}

function addCalendarDays(isoDate: string, days: number): string {
  const [yearPart, monthPart, dayPart] = isoDate.split("-");
  const date = new Date(
    Date.UTC(Number(yearPart), Number(monthPart) - 1, Number(dayPart) + days),
  );
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

export function fixedRangeToPeriod(
  range: Exclude<UsageRecordRange, "billingPeriod">,
  tz: string,
): UsagePeriod {
  const now = nowDate();
  const todayDate = calendarDateInTz(now, tz);
  const todayStart = startOfCalendarDateInTz(todayDate, tz);

  switch (range) {
    case "today": {
      return { start: todayStart, end: now };
    }
    case "yesterday": {
      const start = startOfCalendarDateInTz(addCalendarDays(todayDate, -1), tz);
      return { start, end: todayStart };
    }
    case "24h": {
      return { start: new Date(now.getTime() - DAY_MS), end: now };
    }
    case "7d": {
      return { start: new Date(now.getTime() - 7 * DAY_MS), end: now };
    }
  }
}
