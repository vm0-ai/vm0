import { creditExpiresRecord } from "../../../db/schema/credit-expires-record";
import { grantOrgCredits } from "../org/org-service";

export const STARTER_GRANT_AMOUNT = 10_000;
export const STARTER_GRANT_SOURCE = "starter_grant";

/**
 * The transaction handle passed to `ensureStarterCreditGrant`.
 *
 * This MUST be the parameter of `db.transaction(async (tx) => { ... })`,
 * never the outer `db` handle itself. The helper performs two writes that
 * must share a tx — if they split, the `credit_expires_record` row could
 * land without the matching `org_metadata.credits` bump, and the partial
 * unique index `uq_credit_expires_starter_grant` would then permanently
 * pin the org at 0 credits.
 *
 * Drizzle's transaction callback type is structurally compatible with the
 * outer db handle, so this alias is a documentation aid rather than a
 * nominal guard. Callers must respect the tx-only contract.
 */
type StarterGrantTx = Parameters<
  Parameters<typeof globalThis.services.db.transaction>[0]
>[0];

/**
 * Idempotently give a free-tier org its 10k starter credits with a 1-month
 * expiry. Safe to call from any `org_metadata` insert path.
 *
 * Callers MUST pass a `StarterGrantTx` (i.e. run inside `db.transaction`).
 * The helper performs two writes (credit_expires_record insert and
 * grantOrgCredits) that must be atomic — see `StarterGrantTx` for details.
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
  tx: StarterGrantTx,
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
