import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { nowDate } from "../external/time";
import { logger } from "../../lib/log";

const L = logger("OrgBillingPeriod");

interface OrgBillingPeriod {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Resolve an org's current billing period `{ start, end }`.
 *
 * Reads `orgMetadata.currentPeriodEnd` first; if missing or expired AND a
 * `stripeSubscriptionId` exists, falls back to `stripe.subscriptions.retrieve`
 * and writes the refreshed value back to orgMetadata. Mirrors apps/web's
 * `getOrgBillingPeriod` exactly (same Stripe-API rationale, same
 * past-dated guard).
 *
 * Returns `null` for free-tier orgs (no subscription, no period). Callers
 * MUST short-circuit on null — there is no synthetic period for the free
 * tier; spend admission already handles per-request cap enforcement.
 *
 * In Stripe v2025 API, `current_period_end` was removed from the top-level
 * Subscription object. The replacement is
 * `subscription.items.data[i].current_period_end` — the end time of the
 * subscription item's current billing period. Do NOT read
 * `invoice.period_end` (that's the accrual period for the invoice, not the
 * subscription period, and for renewal invoices collapses to the invoice
 * creation moment, which would cause this function to re-fetch Stripe on
 * every call).
 */
export const getOrgBillingPeriod$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<OrgBillingPeriod | null> => {
    const writeDb = set(writeDb$);

    const [orgRow] = await writeDb
      .select({
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();

    let periodEnd = orgRow?.currentPeriodEnd ?? null;
    const now = nowDate();

    if ((!periodEnd || periodEnd < now) && orgRow?.stripeSubscriptionId) {
      if (periodEnd && periodEnd < now) {
        L.warn("currentPeriodEnd is stale, refreshing from Stripe", {
          orgId,
          currentPeriodEnd: periodEnd,
        });
      }
      const stripe = getStripeClient();
      const subscription = await stripe.subscriptions.retrieve(
        orgRow.stripeSubscriptionId,
      );
      signal.throwIfAborted();
      const itemPeriodEnd = subscription.items.data[0]?.current_period_end;
      if (itemPeriodEnd) {
        const refreshed = new Date(itemPeriodEnd * 1000);
        // Don't cache a past-dated period. If Stripe returns a past-dated
        // current_period_end for a subscription we believe is active,
        // something is wrong (stale Stripe data, field confusion from a
        // future code change, or an orphaned subscription). Log at warn
        // and return null without caching — caching the bad value would
        // cause an infinite "refresh from Stripe" loop on every call.
        if (refreshed < now) {
          L.warn("refreshed periodEnd still in past, not caching", {
            orgId,
            stripeSubscriptionId: orgRow.stripeSubscriptionId,
            periodEnd: refreshed,
          });
          return null;
        }
        periodEnd = refreshed;
        await writeDb
          .update(orgMetadata)
          .set({ currentPeriodEnd: periodEnd, updatedAt: nowDate() })
          .where(eq(orgMetadata.orgId, orgId));
        signal.throwIfAborted();
      }
    }

    if (periodEnd) {
      const periodStart = new Date(periodEnd);
      periodStart.setMonth(periodStart.getMonth() - 1);
      L.debug("billing period resolved", { orgId, periodStart, periodEnd });
      return { start: periodStart, end: periodEnd };
    }

    return null;
  },
);
