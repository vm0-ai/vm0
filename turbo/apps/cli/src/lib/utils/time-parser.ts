/**
 * Time parser utility for --since option
 *
 * Supports:
 * - Relative time: 5s, 10m, 2h, 1d, 1w (seconds, minutes, hours, days, weeks)
 * - Absolute time: ISO 8601 format (2024-01-15T10:30:00Z)
 * - Unix timestamp: 1705312200 or 1705312200000 (seconds or milliseconds)
 */

/**
 * Parse a time string and return a Unix timestamp in milliseconds
 * @param timeStr - Time string to parse
 * @returns Unix timestamp in milliseconds
 * @throws Error if the time string is invalid
 */
const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
const DAYS_BY_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function parseTime(timeStr: string): number {
  // Try relative time first (e.g., "5m", "2h", "1d")
  const relativeMatch = timeStr.match(/^(\d+)([smhdw])$/);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1]!, 10);
    const unit = relativeMatch[2]!;
    return parseRelativeTime(value, unit);
  }

  // Try Unix timestamp (seconds or milliseconds)
  if (/^\d+$/.test(timeStr)) {
    const timestamp = parseInt(timeStr, 10);
    // If timestamp is less than year 2000 in seconds, assume it's already in ms
    // If it looks like seconds (< 10000000000), convert to ms
    if (timestamp < 10000000000) {
      return timestamp * 1000;
    }
    return timestamp;
  }

  // Try ISO 8601 format
  const timestamp = parseIsoTime(timeStr);
  if (timestamp !== undefined) {
    return timestamp;
  }

  throw new Error(
    `Invalid time format: "${timeStr}". ` +
      `Supported formats: relative (5m, 2h, 1d), ISO 8601 (2024-01-15T10:30:00Z), Unix timestamp`,
  );
}

function parseIsoTime(timeStr: string): number | undefined {
  const match = ISO_8601_PATTERN.exec(timeStr);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] ? Number(match[4]) : 0;
  const minute = match[5] ? Number(match[5]) : 0;
  const second = match[6] ? Number(match[6]) : 0;

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }

  const timestamp = new Date(timeStr).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return DAYS_BY_MONTH[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Parse relative time and return Unix timestamp in milliseconds
 */
function parseRelativeTime(value: number, unit: string): number {
  const now = Date.now();
  const multipliers: Record<string, number> = {
    s: 1000, // seconds
    m: 60 * 1000, // minutes
    h: 60 * 60 * 1000, // hours
    d: 24 * 60 * 60 * 1000, // days
    w: 7 * 24 * 60 * 60 * 1000, // weeks
  };

  const multiplier = multipliers[unit];
  if (!multiplier) {
    throw new Error(`Unknown time unit: ${unit}`);
  }

  return now - value * multiplier;
}
