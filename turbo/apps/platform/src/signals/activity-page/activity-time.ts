import { formatAppNumber, resolvedAppLocale } from "../../i18n/format.ts";

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format an activity timestamp without the calendar date. */
export function formatActivityClockTime(timestamp: string): string {
  const date = parseTimestamp(timestamp);
  if (!date) {
    return timestamp.trim().length > 0 ? timestamp : "—";
  }

  return new Intl.DateTimeFormat(resolvedAppLocale(), {
    fractionalSecondDigits: 3,
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatSignedElapsedTime(deltaMs: number): string {
  const sign = deltaMs < 0 ? "-" : "+";
  const absoluteMs = Math.abs(Math.round(deltaMs));
  const hours = Math.floor(absoluteMs / 3_600_000);
  const minutes = Math.floor(absoluteMs / 60_000) % 60;
  const seconds = Math.floor(absoluteMs / 1000) % 60;
  const milliseconds = absoluteMs % 1000;
  const secondsWithMilliseconds = formatAppNumber(
    seconds + milliseconds / 1000,
    {
      maximumFractionDigits: 3,
      minimumFractionDigits: 3,
      minimumIntegerDigits: 2,
      useGrouping: false,
    },
  );
  const clock =
    hours > 0
      ? `${pad(hours, 2)}:${pad(minutes, 2)}:${secondsWithMilliseconds}`
      : `${pad(minutes, 2)}:${secondsWithMilliseconds}`;

  return `${sign}${clock}`;
}

export function formatActivityDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${formatAppNumber(ms, {
      maximumFractionDigits: 0,
      useGrouping: false,
    })}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${formatAppNumber(seconds, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
      useGrouping: false,
    })}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${formatAppNumber(minutes, {
    maximumFractionDigits: 0,
    useGrouping: false,
  })}m ${formatAppNumber(remainingSeconds, {
    maximumFractionDigits: 0,
    useGrouping: false,
  })}s`;
}

/**
 * Format an event timestamp and, when available, its offset from run start.
 * The offset uses a signed race-timing style so events before the recorded
 * start remain distinguishable too.
 */
export function formatActivityEventTime(
  timestamp: string,
  startedAt?: string | null,
): string {
  const formatted = formatActivityClockTime(timestamp);
  const eventDate = parseTimestamp(timestamp);
  const startDate = parseTimestamp(startedAt);
  if (!eventDate || !startDate) {
    return formatted;
  }

  return `${formatted} (${formatSignedElapsedTime(
    eventDate.getTime() - startDate.getTime(),
  )})`;
}
