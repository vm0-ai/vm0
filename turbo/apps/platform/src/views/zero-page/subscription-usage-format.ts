import { now } from "../../lib/time.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

interface SubscriptionUsageResetFormat {
  readonly absoluteResetText: string;
  readonly absoluteText: string;
  readonly relativeText: string;
  readonly tooltipTitle: string;
}

interface InvalidSubscriptionUsageResetFormat {
  readonly fallbackText: string;
}

type SubscriptionUsageResetDisplay =
  | InvalidSubscriptionUsageResetFormat
  | SubscriptionUsageResetFormat;

export function formatSubscriptionUsageReset(
  resetAt: string | null,
): SubscriptionUsageResetDisplay | null {
  const text = resetAt?.trim();
  if (!text) {
    return null;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return { fallbackText: `resets ${text}` };
  }

  const absoluteText = formatAbsoluteResetDate(date);
  const relativeText = formatRelativeResetTime(date.getTime() - now());

  return {
    absoluteResetText: `resets ${absoluteText}`,
    absoluteText,
    relativeText,
    tooltipTitle:
      relativeText === "reset time passed"
        ? "Reset time passed"
        : `Resets ${relativeText}`,
  };
}

function formatAbsoluteResetDate(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  const browserTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (browserTimeZone) {
    options.timeZone = browserTimeZone;
  }
  return date.toLocaleDateString("en-US", options);
}

function formatRelativeResetTime(remainingMs: number): string {
  if (remainingMs <= 0) {
    return "reset time passed";
  }
  if (remainingMs < MINUTE_MS) {
    return "in <1m";
  }

  const totalMinutes = Math.floor(remainingMs / MINUTE_MS);
  if (remainingMs < HOUR_MS) {
    return `in ${totalMinutes}m`;
  }

  const totalHours = Math.floor(remainingMs / HOUR_MS);
  if (remainingMs < DAY_MS) {
    const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `in ${totalHours}h ${minutes}m` : `in ${totalHours}h`;
  }

  const totalDays = Math.floor(remainingMs / DAY_MS);
  if (remainingMs < WEEK_MS) {
    const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
    return hours > 0 ? `in ${totalDays}d ${hours}h` : `in ${totalDays}d`;
  }

  return `in ${totalDays}d`;
}
