export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      return typeof entry === "string";
    })
  );
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
