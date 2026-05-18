import { sql } from "drizzle-orm";

/**
 * Atomically deduct credits from an org's balance.
 *
 * Uses INSERT ON CONFLICT UPDATE so the row is created with `-amount`
 * if it doesn't exist, or decremented if it does.
 *
 * Accepts a Drizzle transaction so the deduction can be part of
 * a larger atomic operation (e.g. credit processing).
 *
 * Intentionally does NOT call ensureStarterCreditGrant — this primitive
 * runs after usage_event was already recorded, which implies onboarding
 * (or test-token) has already created the org_metadata row with the
 * starter grant. The ON CONFLICT INSERT path here is a defensive fallback
 * for orgs that somehow lack a row; it creates a row with negative credits,
 * which is visible and recoverable.
 */
export async function deductOrgCredits(
  tx: Parameters<Parameters<typeof globalThis.services.db.transaction>[0]>[0],
  orgId: string,
  amount: number,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${-amount}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits - ${amount}, updated_at = now()`,
  );
}

/**
 * Atomically grant credits to an org's balance (inverse of deductOrgCredits).
 *
 * Credits rollover (accumulate) — adds to existing balance.
 * Uses the same INSERT ON CONFLICT pattern as deductOrgCredits.
 *
 * Intentionally does NOT call ensureStarterCreditGrant — callers are either
 * paid flows (handleInvoicePaid, handleAutoRechargeInvoicePaid) whose orgs
 * already have a row, or the starter-grant helper itself. Wiring the helper
 * here would be a cycle.
 */
export async function grantOrgCredits(
  tx: Parameters<Parameters<typeof globalThis.services.db.transaction>[0]>[0],
  orgId: string,
  amount: number,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${amount}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits + ${amount}, updated_at = now()`,
  );
}
