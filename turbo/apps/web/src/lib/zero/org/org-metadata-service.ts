import { eq } from "drizzle-orm";
import { orgTierSchema, type OrgTier } from "@vm0/core/contracts/orgs";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { isNotFound, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getStripe } from "../stripe";

const log = logger("service:org-metadata");

export interface OrgMetadata {
  orgId: string;
  tier: string;
  credits: number;
}

/**
 * Read org metadata from the platform-owned org_metadata table.
 * Returns tier, credits, and other platform fields.
 *
 * Unlike getOrgNameAndSlug(), this function NEVER calls the Clerk API —
 * it only reads from our own database.
 */
export async function getOrgMetadata(orgId: string): Promise<OrgMetadata> {
  const db = globalThis.services.db;
  const [row] = await db
    .select({ tier: orgMetadata.tier, credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (!row) {
    throw notFound(`Organization ${orgId} not found`);
  }
  return {
    orgId,
    tier: row.tier,
    credits: row.credits,
  };
}

/**
 * Read the org tier from org_metadata, defaulting to "free" for brand-new
 * orgs that don't have an org_metadata row yet. Unknown tier strings in the
 * database will fail-fast via Zod parsing rather than silently pass through.
 */
export async function getOrgTierSafe(orgId: string): Promise<OrgTier> {
  try {
    const { tier } = await getOrgMetadata(orgId);
    return orgTierSchema.parse(tier);
  } catch (error) {
    if (isNotFound(error)) return "free";
    throw error;
  }
}

/**
 * Get the current billing period for an org by reading org_metadata directly.
 *
 * Returns `{ start, end }` for paying orgs, or `null` for free tier (no billing period).
 * Falls back to Stripe when currentPeriodEnd is not cached in org_metadata.
 */
export async function getOrgBillingPeriod(
  orgId: string,
): Promise<{ start: Date; end: Date } | null> {
  const db = globalThis.services.db;

  // Read from org_metadata directly
  const [orgRow] = await db
    .select({
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  let periodEnd = orgRow?.currentPeriodEnd ?? null;

  const now = new Date();
  if ((!periodEnd || periodEnd < now) && orgRow?.stripeSubscriptionId) {
    // Has subscription but period is missing or expired — fetch from Stripe.
    // In Stripe v2025 API, current_period_end was removed from the top-level
    // Subscription object. The replacement is subscription.items.data[i].
    // current_period_end — the end time of the subscription item's current
    // billing period. (Do NOT read invoice.period_end — that field is the
    // accrual period for the invoice, not the subscription period, and for
    // renewal invoices collapses to the invoice creation moment, which
    // would cause this function to re-fetch Stripe on every call.)
    if (periodEnd && periodEnd < now) {
      log.warn("currentPeriodEnd is stale, refreshing from Stripe", {
        orgId,
        currentPeriodEnd: periodEnd,
      });
    }
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(
      orgRow.stripeSubscriptionId,
    );
    const itemPeriodEnd = subscription.items.data[0]?.current_period_end;
    if (itemPeriodEnd) {
      const refreshed = new Date(itemPeriodEnd * 1000);

      // Don't cache a past-dated period. If Stripe returns a past-dated
      // current_period_end for a subscription we believe is active, something
      // is wrong (stale Stripe data, field confusion from a future code
      // change, or an orphaned subscription). Log at warn so Axiom surfaces
      // it and return null without caching — caching the bad value would
      // cause an infinite "refresh from Stripe" loop on every call.
      if (refreshed < now) {
        log.warn("refreshed periodEnd still in past, not caching", {
          orgId,
          stripeSubscriptionId: orgRow.stripeSubscriptionId,
          periodEnd: refreshed,
        });
        return null;
      }

      periodEnd = refreshed;

      // Update org_metadata so future lookups skip Stripe
      await db
        .update(orgMetadata)
        .set({ currentPeriodEnd: periodEnd, updatedAt: new Date() })
        .where(eq(orgMetadata.orgId, orgId));
    }
  }

  if (periodEnd) {
    // Compute start = end - 1 month
    const periodStart = new Date(periodEnd);
    periodStart.setMonth(periodStart.getMonth() - 1);

    log.debug("billing period resolved", { orgId, periodStart, periodEnd });
    return { start: periodStart, end: periodEnd };
  }

  return null;
}
