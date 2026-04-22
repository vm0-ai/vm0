import { eq, and, gt, lte, asc, sql } from "drizzle-orm";
import { creditExpiresRecord } from "../../../db/schema/credit-expires-record";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { logger } from "../../shared/logger";

const log = logger("service:credit-expires");

/** Drizzle transaction type (matches pattern from org-service.ts). */
type Tx = Parameters<
  Parameters<typeof globalThis.services.db.transaction>[0]
>[0];

/**
 * Insert a new credit expires record.
 * Uses ON CONFLICT DO NOTHING for idempotency — relies on the partial unique index
 * uq_credit_expires_invoice on (org_id, stripe_invoice_id) where stripe_invoice_id IS NOT NULL.
 * No explicit target is specified because PostgreSQL cannot use partial indexes as
 * conflict targets via column notation; the unconditional DO NOTHING form works instead.
 *
 * Returns `true` when a new row was inserted and `false` when the row already
 * existed (Stripe webhook retry). Callers that need to gate side effects
 * (e.g. granting credits) on a fresh insert should check the return value.
 */
export async function createExpiresRecord(
  tx: Tx,
  orgId: string,
  params: {
    source: string;
    stripeInvoiceId: string;
    amount: number;
    expiresAt: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: params.source,
      stripeInvoiceId: params.stripeInvoiceId,
      amount: params.amount,
      remaining: params.amount,
      expiresAt: params.expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });
  return rows.length > 0;
}

/**
 * FEFO deduction: consume expiring credits first (First Expiring, First Out).
 *
 * Selects active records ordered by expires_at ASC and decrements remaining
 * until the requested amount is covered. If total remaining < amount, the
 * excess comes from non-expiring credits (no error).
 *
 * Time-aware: expired rows are skipped so they can never back a spend, even
 * if the caller forgot to settle first. Paired with `expireCredits` in the
 * same transaction this is defensive; alone it still prevents the leak.
 */
export async function deductFromExpiresRecords(
  tx: Tx,
  orgId: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;

  const records = await tx
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        gt(creditExpiresRecord.remaining, 0),
        gt(creditExpiresRecord.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(creditExpiresRecord.expiresAt))
    .for("update");

  let left = amount;
  for (const record of records) {
    if (left <= 0) break;
    const deduct = Math.min(left, record.remaining);
    await tx
      .update(creditExpiresRecord)
      .set({ remaining: record.remaining - deduct })
      .where(eq(creditExpiresRecord.id, record.id));
    left -= deduct;
  }
  // If left > 0, the excess comes from non-expiring credits — that's fine.
}

/**
 * Settle expired credits: find records past their expiry with remaining > 0,
 * zero them out, and deduct the total from org_metadata.credits.
 *
 * Called from handleInvoicePaid() BEFORE granting new credits.
 */
export async function expireCredits(tx: Tx, orgId: string): Promise<number> {
  const expired = await tx
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        lte(creditExpiresRecord.expiresAt, new Date()),
        gt(creditExpiresRecord.remaining, 0),
      ),
    )
    .for("update");

  if (expired.length === 0) return 0;

  const totalExpired = expired.reduce((sum, r) => {
    return sum + r.remaining;
  }, 0);

  // Zero out all expired records
  for (const record of expired) {
    await tx
      .update(creditExpiresRecord)
      .set({ remaining: 0 })
      .where(eq(creditExpiresRecord.id, record.id));
  }

  // Deduct expired amount from org balance
  if (totalExpired > 0) {
    await tx
      .update(orgMetadata)
      .set({
        credits: sql`GREATEST(${orgMetadata.credits} - ${totalExpired}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(orgMetadata.orgId, orgId));
  }

  log.info("expired credits settled", { orgId, totalExpired });
  return totalExpired;
}

/**
 * Sum of credits on rows that are already past their expiry but haven't been
 * settled yet (i.e. `remaining > 0 AND expires_at <= now()`). These are
 * already excluded from spend by `deductFromExpiresRecords`, but the
 * `org_metadata.credits` aggregate still includes them until the next
 * `expireCredits` call. Use this to present the true spendable balance on
 * read paths that run outside the settlement transaction.
 *
 * Accepts an optional `db` so callers already running inside a transaction
 * (e.g. the admission gate inside `dequeueNextAtomic`) can pass their tx
 * handle and keep both reads under the same isolation boundary.
 */
export async function getUnsettledExpiredAmount(
  orgId: string,
  db: typeof globalThis.services.db = globalThis.services.db,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${creditExpiresRecord.remaining}), 0)::int`,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        lte(creditExpiresRecord.expiresAt, new Date()),
        gt(creditExpiresRecord.remaining, 0),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Read-only summary of expiring credits for API/UI.
 * Returns the total credits expiring in the next cycle and the earliest expiry date.
 */
export async function getExpiresRecordsSummary(orgId: string): Promise<{
  expiringNextCycle: number;
  nextExpiryDate: Date | null;
}> {
  const db = globalThis.services.db;

  const records = await db
    .select({
      remaining: creditExpiresRecord.remaining,
      expiresAt: creditExpiresRecord.expiresAt,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        gt(creditExpiresRecord.remaining, 0),
        gt(creditExpiresRecord.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(creditExpiresRecord.expiresAt));

  const firstRecord = records[0];
  if (!firstRecord) {
    return { expiringNextCycle: 0, nextExpiryDate: null };
  }

  // The earliest expiry date is the "next cycle" boundary
  const nextExpiryDate = firstRecord.expiresAt;

  // Sum remaining for records expiring at the earliest date
  const expiringNextCycle = records
    .filter((r) => {
      return r.expiresAt.getTime() === nextExpiryDate.getTime();
    })
    .reduce((sum, r) => {
      return sum + r.remaining;
    }, 0);

  return { expiringNextCycle, nextExpiryDate };
}
