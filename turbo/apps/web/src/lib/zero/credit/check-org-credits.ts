import { sql } from "drizzle-orm";
import { insufficientCredits } from "@vm0/api-services/errors";
import type { Database } from "../../../types/global";

export interface CheckOrgCreditsOptions {
  preloadedOrgCredits?: {
    orgId: string;
    credits: number;
  };
}

interface CreditCheckRow extends Record<string, unknown> {
  credit_enabled: boolean | null;
  credits: string | null;
  unsettled_expired: string | null;
}

function isDatabase(value: unknown): value is Database {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

/**
 * Pre-flight check: ensure the member can spend vm0-bundled credits for this org.
 *
 * Throws `insufficientCredits` if either:
 *   - the member's `credit_enabled` flag is false (hit their billing-cycle cap), or
 *   - `org_metadata.credits − Σ unsettled-expired ≤ 0`.
 *
 * The spendable balance subtracts unsettled expired records so a dormant
 * non-subscription org whose credits have expired (but haven't yet been
 * settled by `processOrgUsageEvents` or the next renewal) isn't admitted on its
 * stale inflated balance — same form `getBillingStatus` presents in the UI.
 *
 * Callable from any vm0-billable route. For LLM runs that may use BYOK,
 * first resolve the run admission context, then call
 * `checkOrgCreditsForRunAdmission` in zero-run-policy.
 *
 * Accepts an optional `db` so callers inside a transaction (e.g. queue drain
 * under `pg_advisory_xact_lock`) can keep the read within the same boundary.
 * Callers that already fetched org_metadata may pass preloaded credits either
 * as the third argument or after the db handle.
 */
export async function checkOrgCredits(
  orgId: string,
  userId: string,
  dbOrOptions: Database | CheckOrgCreditsOptions = globalThis.services.db,
  options: CheckOrgCreditsOptions = {},
): Promise<void> {
  const db = isDatabase(dbOrOptions) ? dbOrOptions : globalThis.services.db;
  const resolvedOptions = isDatabase(dbOrOptions) ? options : dbOrOptions;
  const preloaded = resolvedOptions.preloadedOrgCredits;
  const { rows } =
    preloaded && preloaded.orgId === orgId
      ? await db.execute<CreditCheckRow>(sql`
          WITH member AS (
            SELECT credit_enabled FROM org_members_metadata
            WHERE org_id = ${orgId} AND user_id = ${userId}
            LIMIT 1
          ),
          expired AS (
            SELECT COALESCE(SUM(remaining), 0)::bigint AS total
            FROM credit_expires_record
            WHERE org_id = ${orgId}
              AND expires_at <= now()
              AND remaining > 0
          )
          SELECT
            (SELECT credit_enabled FROM member) AS credit_enabled,
            ${preloaded.credits}::bigint AS credits,
            (SELECT total FROM expired) AS unsettled_expired
        `)
      : await db.execute<CreditCheckRow>(sql`
          WITH member AS (
            SELECT credit_enabled FROM org_members_metadata
            WHERE org_id = ${orgId} AND user_id = ${userId}
            LIMIT 1
          ),
          org AS (
            SELECT credits FROM org_metadata
            WHERE org_id = ${orgId}
            LIMIT 1
          ),
          expired AS (
            SELECT COALESCE(SUM(remaining), 0)::bigint AS total
            FROM credit_expires_record
            WHERE org_id = ${orgId}
              AND expires_at <= now()
              AND remaining > 0
          )
          SELECT
            (SELECT credit_enabled FROM member) AS credit_enabled,
            (SELECT credits FROM org) AS credits,
            (SELECT total FROM expired) AS unsettled_expired
        `);

  const row = rows[0];
  if (!row) throw insufficientCredits();
  if (row.credit_enabled === false) throw insufficientCredits();
  if (row.credits == null) throw insufficientCredits();

  const credits = Number(row.credits);
  const unsettledExpired = Number(row.unsettled_expired ?? 0);
  if (credits - unsettledExpired <= 0) throw insufficientCredits();
}
