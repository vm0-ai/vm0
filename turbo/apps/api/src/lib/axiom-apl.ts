// Escape a string literal for safe interpolation into an APL `where` clause.
// APL string literals are double-quoted; backslash and double-quote must be
// escaped so user-controlled values cannot break out of the literal.
export function escapeAplString(value: string): string {
  return value.replace(/\\/g, String.raw`\\`).replace(/"/g, String.raw`\"`);
}
