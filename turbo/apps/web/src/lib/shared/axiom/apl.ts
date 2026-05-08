export function escapeAplString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export function quoteAplString(value: string): string {
  return `"${escapeAplString(value)}"`;
}
