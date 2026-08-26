import { isUniqueViolation } from "./pg-errors";

/**
 * Resolve one settled immutable-dedupe `INSERT ... RETURNING` while leaving
 * the physical unique index as the race arbiter. Only an exact PostgreSQL
 * 23505 maps to the duplicate result.
 *
 * Callers must settle a standalone statement issued through the top-level Db.
 * Classifying the statement error here does not make an ambient PostgreSQL
 * transaction usable again after that transaction enters the aborted state.
 */
export function resolveImmutableDedupeInsert<T>(
  insert:
    | { readonly ok: true; readonly value: readonly T[] }
    | { readonly ok: false; readonly error: unknown },
): T | null {
  if (insert.ok) {
    const row = insert.value[0];
    if (row === undefined) {
      throw new Error("Immutable dedupe INSERT ... RETURNING returned no row");
    }
    return row;
  }
  if (isUniqueViolation(insert.error)) {
    return null;
  }
  throw insert.error;
}
