export function formatIsoTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    return "invalid-date";
  }
  return timestamp.toISOString().replace(/\.\d{3}Z$/, "Z");
}
