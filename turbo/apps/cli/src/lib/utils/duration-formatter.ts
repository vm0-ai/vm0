/**
 * Duration formatter utility for human-readable time display
 *
 * Formats milliseconds into readable strings like:
 * - "2h 53m 22s" (hours + minutes + seconds)
 * - "45m 32s" (minutes + seconds, < 1 hour)
 * - "32s" (seconds only, < 1 minute)
 * - "< 1s" (less than 1 second)
 * - "-" (zero or null)
 */

/**
 * Format duration in milliseconds to human-readable string
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms === 0) {
    return "-";
  }

  if (ms < 0) {
    return "-";
  }

  const totalSeconds = Math.floor(ms / 1000);

  if (totalSeconds === 0) {
    return "< 1s";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}
