import { creditExpiresRecord } from "../../../db/schema/credit-expires-record";
import { grantOrgCredits } from "../org/org-service";

export const STARTER_GRANT_AMOUNT = 100_000;
export const STARTER_GRANT_SOURCE = "starter_grant";

type Tx = Parameters<
  Parameters<typeof globalThis.services.db.transaction>[0]
>[0];

/**
 * Idempotently give a free-tier org its 100k starter credits with a 1-month
 * expiry. Safe to call from any `org_metadata` insert path.
 *
 * Idempotency is enforced by the partial unique index
 *   uq_credit_expires_starter_grant ON (org_id) WHERE source = 'starter_grant'
 * combined with INSERT ... ON CONFLICT DO NOTHING RETURNING id. Only the
 * winning insert triggers the matching credit add, so concurrent callers
 * never double-grant.
 *
 * This is the single public entry point for the starter grant. The column
 * default for org_metadata.credits is 0 — skipping this helper means the
 * org gets 0 credits, which is visible in the UI and easy to catch.
 */
export async function ensureStarterCreditGrant(
  tx: Tx,
  orgId: string,
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  const inserted = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: STARTER_GRANT_SOURCE,
      stripeInvoiceId: null,
      amount: STARTER_GRANT_AMOUNT,
      remaining: STARTER_GRANT_AMOUNT,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });

  if (inserted.length === 0) return;

  await grantOrgCredits(tx, orgId, STARTER_GRANT_AMOUNT);
}
