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
  const date = new Date(timeStr);
  if (!isNaN(date.getTime())) {
    return date.getTime();
  }

  throw new Error(
    `Invalid time format: "${timeStr}". ` +
      `Supported formats: relative (5m, 2h, 1d), ISO 8601 (2024-01-15T10:30:00Z), Unix timestamp`,
  );
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

/**
 * Format a timestamp for display
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
