// Escape a string literal for safe interpolation into an APL query.
// APL string literals are double-quoted; control characters that APL treats as
// escape sequences must be represented with backslash escapes.
export function escapeAplString(value: string): string {
  return value
    .replace(/\\/g, String.raw`\\`)
    .replace(/"/g, String.raw`\"`)
    .replace(/\t/g, String.raw`\t`)
    .replace(/\r\n/g, String.raw`\n`)
    .replace(/\r/g, String.raw`\n`)
    .replace(/\n/g, String.raw`\n`);
}
