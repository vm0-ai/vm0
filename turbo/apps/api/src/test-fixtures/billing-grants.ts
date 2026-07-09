import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Past-dates an org's Atom grant window (`orgMetadata.currentPeriodEnd` plus
 * every credit expiry record) so the reconcile-billing cron observes an
 * already-expired grant.
 *
 * Why product APIs cannot construct this state deterministically:
 * - `POST /api/webhooks/stripe` rejects atom-grant invoices whose
 *   `atomGrantExpiresAt` is not strictly in the future, so an expired grant
 *   can never be created through the webhook.
 * - Advancing the mocked clock instead is not viable: the reconcile cron
 *   sweeps the whole (shared, persistent) test database, so global time
 *   travel turns unrelated leftover rows from other test runs into stale
 *   candidates and makes the cron fail nondeterministically.
 */
export async function expireAtomGrants(
  orgId: string,
  expiredAt: Date,
): Promise<void> {
  await db()
    .update(orgMetadata)
    .set({ currentPeriodEnd: expiredAt, updatedAt: expiredAt })
    .where(eq(orgMetadata.orgId, orgId));
  await db()
    .update(creditExpiresRecord)
    .set({ expiresAt: expiredAt })
    .where(eq(creditExpiresRecord.orgId, orgId));
}
