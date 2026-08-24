const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_LOCK_NOT_AVAILABLE = "55P03";
const PG_UNDEFINED_TABLE = "42P01";
const PG_UNIQUE_VIOLATION = "23505";

function pgErrorCode(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const { cause } = error;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }

  return cause.code;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION;
}

export function isLockNotAvailable(error: unknown): boolean {
  return pgErrorCode(error) === PG_LOCK_NOT_AVAILABLE;
}

export function isUndefinedTable(error: unknown): boolean {
  return pgErrorCode(error) === PG_UNDEFINED_TABLE;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_UNIQUE_VIOLATION;
}
