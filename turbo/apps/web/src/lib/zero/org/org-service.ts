import { sql } from "drizzle-orm";

/**
 * Atomically grant credits to an org's balance.
 *
 * Credits rollover (accumulate) — adds to existing balance.
 * Uses INSERT ON CONFLICT UPDATE so the row is created if needed.
 *
 * Intentionally does NOT call ensureStarterCreditGrant — callers are either
 * paid webhook flows (subscription renewal and auto-recharge) whose orgs
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
