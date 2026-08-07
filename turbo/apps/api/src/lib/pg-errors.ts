const PG_FOREIGN_KEY_VIOLATION = "23503";

export function isForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const { cause } = error;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return false;
  }

  return cause.code === PG_FOREIGN_KEY_VIOLATION;
}
