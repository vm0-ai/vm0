/**
 * Format a credit count with K/M abbreviation for compact display.
 *
 * - >= 1,000,000 → "x.x M" (e.g. 2,300,000 → "2.3 M")
 * - >= 1,000     → "x.x K" (e.g. 12,400    → "12.4 K")
 * - <  1,000     → exact integer string  (e.g. 999      → "999")
 */
export function formatCredits(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)} M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)} K`;
  }
  return String(n);
}
