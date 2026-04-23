// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * True iff `err` wraps a postgres driver error with SQLSTATE `23503`
 * (foreign_key_violation). Drizzle wraps the underlying PG error on
 * `.cause`; the postgres.js driver surfaces the SQLSTATE on `.code`.
 *
 * Webhook handlers use this to recognize "the `agent_runs` row vanished
 * between auth and INSERT" races (see #10725) and silently drop the
 * event rather than returning 500.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const { cause } = err;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return false;
  }
  return cause.code === PG_FOREIGN_KEY_VIOLATION;
}
