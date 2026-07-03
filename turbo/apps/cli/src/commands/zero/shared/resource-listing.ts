import type { RegistryEntry } from "./resource-registry";

/**
 * Format a list of registry entries for help text or error messages.
 *
 * Each entry renders as a two-line block:
 *
 * ```
 *   <id>
 *     <desc or description>
 * ```
 *
 * Blank line between entries. Returns a single placeholder line when the
 * list is empty so callers can drop this directly into help output.
 */
export function formatRegistryListing(
  entries: readonly RegistryEntry[],
  emptyLabel: string,
): string {
  if (entries.length === 0) {
    return `  (no ${emptyLabel} registered)`;
  }
  return entries
    .map((entry) => {
      const desc = entry.desc ?? entry.description;
      return `  ${entry.id}\n    ${desc}`;
    })
    .join("\n\n");
}

/**
 * Canonicalize a user-supplied registry id by prepending the resource-kind
 * prefix when missing. Accepts either `apple` or `design-system:apple`,
 * `html-ppt-pitch-deck` or `template:html-ppt-pitch-deck`, etc.
 */
export function canonicalizeRegistryId(prefix: string, value: string): string {
  const fullPrefix = `${prefix}:`;
  if (value.startsWith(fullPrefix)) {
    return value;
  }
  return `${fullPrefix}${value}`;
}
