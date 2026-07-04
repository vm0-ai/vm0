/**
 * Human-friendly duration handling for loop triggers (`--every` / `--loop`).
 */

const DURATION_PATTERN = /^(\d+)([smhd])$/;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

/**
 * Parse a human duration like "90s", "15m", "1h", "2d" into seconds.
 * @throws Error when the input is not a positive integer + unit
 */
export function parseDurationSeconds(input: string): number {
  const match = input.match(DURATION_PATTERN);
  if (!match) {
    throw new Error(
      `Invalid duration: "${input}". Use <number><unit> with unit s, m, h, or d (e.g. 90s, 15m, 1h)`,
    );
  }

  const value = parseInt(match[1]!, 10);
  if (value <= 0) {
    throw new Error(`Invalid duration: "${input}". Must be greater than zero`);
  }

  return value * UNIT_SECONDS[match[2]!]!;
}

/**
 * Format seconds back into the largest exact unit (900 → "15m", 90 → "90s")
 */
export function formatDurationSeconds(seconds: number): string {
  for (const [unit, size] of [
    ["d", UNIT_SECONDS.d!],
    ["h", UNIT_SECONDS.h!],
    ["m", UNIT_SECONDS.m!],
  ] as const) {
    if (seconds % size === 0 && seconds >= size) {
      return `${seconds / size}${unit}`;
    }
  }
  return `${seconds}s`;
}
