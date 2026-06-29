import { isValidTimeZone, parseScheduledAtTime } from "@vm0/core/timezone";

function datePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return (
    parts.find((part) => {
      return part.type === type;
    })?.value ?? ""
  );
}

function dateNumberPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  return Number(datePart(parts, type));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function displayTimezone(args: {
  readonly userTimezone: string | null;
  readonly triggerTimezone: string | null;
}): string {
  const candidates = [args.userTimezone, args.triggerTimezone, "UTC"];
  return (
    candidates.find((candidate) => {
      return candidate !== null && isValidTimeZone(candidate);
    }) ?? "UTC"
  );
}

function formatClockTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${pad2(minute)} ${ampm}`;
}

function formatWorkflowTriggerDateTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const time = `${datePart(parts, "hour")}:${datePart(
    parts,
    "minute",
  )} ${datePart(parts, "dayPeriod")}`;
  return `${time}, ${datePart(parts, "month")} ${datePart(
    parts,
    "day",
  )}, ${datePart(parts, "year")} (${timezone})`;
}

function formatWorkflowIntervalSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function parseCronNumber(
  value: string | undefined,
  min: number,
  max: number,
): number | null {
  if (!value || !/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function normalizeCronDayOfWeek(day: number): number {
  return day === 7 ? 0 : day;
}

function parseCronDayOfWeekList(value: string): readonly number[] | null {
  const days: number[] = [];
  for (const part of value.split(",")) {
    const [startRaw, endRaw] = part.split("-");
    const start = parseCronNumber(startRaw, 0, 7);
    const end = parseCronNumber(endRaw ?? startRaw, 0, 7);
    if (start === null || end === null) {
      return null;
    }
    const normalizedStart = normalizeCronDayOfWeek(start);
    const normalizedEnd = normalizeCronDayOfWeek(end);
    if (normalizedStart <= normalizedEnd) {
      for (let day = normalizedStart; day <= normalizedEnd; day += 1) {
        days.push(day);
      }
    } else {
      for (let day = normalizedStart; day <= 6; day += 1) {
        days.push(day);
      }
      for (let day = 0; day <= normalizedEnd; day += 1) {
        days.push(day);
      }
    }
  }
  const unique = [...new Set(days)];
  return unique.length > 0
    ? unique.sort((a, b) => {
        return a - b;
      })
    : null;
}

function shiftCronDays(
  days: readonly number[],
  dayOffset: number,
): readonly number[] {
  return [
    ...new Set(
      days.map((day) => {
        return (day + dayOffset + 7) % 7;
      }),
    ),
  ].sort((a, b) => {
    return a - b;
  });
}

function sameNumberList(a: readonly number[], b: readonly number[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, index) => {
      return value === b[index];
    })
  );
}

function shiftedDayOfMonth(
  dayOfMonth: string,
  dayOffset: number,
): string | null {
  const day = parseCronNumber(dayOfMonth, 1, 31);
  if (day === null) {
    return null;
  }
  const shifted = day + dayOffset;
  return shifted >= 1 && shifted <= 31 ? String(shifted) : String(day);
}

function localDateParts(
  date: Date,
  timezone: string,
): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(date);
  return {
    year: dateNumberPart(parts, "year"),
    month: dateNumberPart(parts, "month"),
    day: dateNumberPart(parts, "day"),
  };
}

function cronWallTimeInTimezone(args: {
  readonly hour: number;
  readonly minute: number;
  readonly sourceTimezone: string;
  readonly displayTimezone: string;
  readonly referenceDate: Date;
}): {
  readonly hour: number;
  readonly minute: number;
  readonly dayOffset: number;
} {
  if (args.sourceTimezone === args.displayTimezone) {
    return { hour: args.hour, minute: args.minute, dayOffset: 0 };
  }
  const sourceDate = localDateParts(args.referenceDate, args.sourceTimezone);
  const parsed = parseScheduledAtTime(
    `${sourceDate.year}-${pad2(sourceDate.month)}-${pad2(sourceDate.day)}T${pad2(
      args.hour,
    )}:${pad2(args.minute)}:00`,
    args.sourceTimezone,
  );
  if (!parsed.ok) {
    return { hour: args.hour, minute: args.minute, dayOffset: 0 };
  }

  const displayParts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: args.displayTimezone,
  }).formatToParts(parsed.date);
  const sourceDay = Date.UTC(
    sourceDate.year,
    sourceDate.month - 1,
    sourceDate.day,
  );
  const displayDay = Date.UTC(
    dateNumberPart(displayParts, "year"),
    dateNumberPart(displayParts, "month") - 1,
    dateNumberPart(displayParts, "day"),
  );
  return {
    hour: dateNumberPart(displayParts, "hour"),
    minute: dateNumberPart(displayParts, "minute"),
    dayOffset: Math.round((displayDay - sourceDay) / 86_400_000),
  };
}

function formatCronRule(args: {
  readonly cronExpression: string;
  readonly triggerTimezone: string;
  readonly displayTimezone: string;
  readonly referenceDate: Date;
}): string {
  const parts = args.cronExpression.trim().split(/\s+/u);
  const minute = parseCronNumber(parts[0], 0, 59);
  const hour = parseCronNumber(parts[1], 0, 23);
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";
  if (parts.length !== 5 || hour === null || minute === null) {
    return `${args.cronExpression} (${args.triggerTimezone})`;
  }
  const converted = cronWallTimeInTimezone({
    hour,
    minute,
    sourceTimezone: args.triggerTimezone,
    displayTimezone: args.displayTimezone,
    referenceDate: args.referenceDate,
  });
  const time = formatClockTime(converted.hour, converted.minute);
  if (dayOfMonth !== "*" && dayOfWeek === "*") {
    const displayDayOfMonth = shiftedDayOfMonth(
      dayOfMonth,
      converted.dayOffset,
    );
    return displayDayOfMonth
      ? `Every month on day ${displayDayOfMonth} at ${time}`
      : `${args.cronExpression} (${args.triggerTimezone})`;
  }
  if (dayOfMonth === "*" && dayOfWeek !== "*") {
    const days = parseCronDayOfWeekList(dayOfWeek);
    if (!days) {
      return `${args.cronExpression} (${args.triggerTimezone})`;
    }
    const displayDays = shiftCronDays(days, converted.dayOffset);
    if (sameNumberList(displayDays, [1, 2, 3, 4, 5])) {
      return `Every weekday at ${time}`;
    }
    const dayNames: Readonly<Record<number, string>> = {
      0: "Sunday",
      1: "Monday",
      2: "Tuesday",
      3: "Wednesday",
      4: "Thursday",
      5: "Friday",
      6: "Saturday",
    };
    const dayLabels = displayDays.map((day) => {
      return dayNames[day];
    });
    return dayLabels.length > 0
      ? `Every week on ${dayLabels.join(", ")} at ${time}`
      : `Every week at ${time}`;
  }
  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return `Every day at ${time}`;
  }
  return `${args.cronExpression} (${args.triggerTimezone})`;
}

export function buildWorkflowScheduleTriggerBrief(args: {
  readonly createdAt: Date;
  readonly scheduleType: string | null;
  readonly cronExpression: string | null;
  readonly intervalSeconds: number | null;
  readonly atTime: Date | null;
  readonly triggerTimezone: string | null;
  readonly userTimezone: string | null;
}): string | null {
  if (args.scheduleType === null) {
    return null;
  }
  const timezone = displayTimezone(args);
  const triggerTimezone =
    args.triggerTimezone !== null && isValidTimeZone(args.triggerTimezone)
      ? args.triggerTimezone
      : timezone;
  const triggeredAt = formatWorkflowTriggerDateTime(args.createdAt, timezone);
  if (args.scheduleType === "cron") {
    const cronExpression = args.cronExpression?.trim();
    if (!cronExpression) {
      return `Triggered at ${triggeredAt}`;
    }
    return [
      `Triggered at ${triggeredAt}`,
      `Schedule: ${formatCronRule({
        cronExpression,
        triggerTimezone,
        displayTimezone: timezone,
        referenceDate: args.createdAt,
      })}`,
    ].join("\n");
  }
  if (args.scheduleType === "loop") {
    if (!args.intervalSeconds) {
      return `Triggered at ${triggeredAt}`;
    }
    return [
      `Triggered at ${triggeredAt}`,
      `Every ${formatWorkflowIntervalSeconds(args.intervalSeconds)}`,
    ].join("\n");
  }
  const onceAt = formatWorkflowTriggerDateTime(
    args.atTime ?? args.createdAt,
    timezone,
  );
  return `Once at ${onceAt}`;
}
