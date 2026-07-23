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

  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(
    date.getSeconds(),
    2,
  )}.${pad(date.getMilliseconds(), 3)}`;
}

function formatSignedElapsedTime(deltaMs: number): string {
  const sign = deltaMs < 0 ? "-" : "+";
  const absoluteMs = Math.abs(Math.round(deltaMs));
  const hours = Math.floor(absoluteMs / 3_600_000);
  const minutes = Math.floor(absoluteMs / 60_000) % 60;
  const seconds = Math.floor(absoluteMs / 1000) % 60;
  const milliseconds = absoluteMs % 1000;
  const clock =
    hours > 0
      ? `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`
      : `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;

  return `${sign}${clock}`;
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
