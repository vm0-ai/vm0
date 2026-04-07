import { eq } from "drizzle-orm";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { logger } from "../../shared/logger";
import { getStripe } from "../stripe";

const log = logger("service:org-metadata");

interface OrgMetadata {
  orgId: string;
  tier: string;
  credits: number;
}

/**
 * Read tier from the org_metadata table (source of truth).
 * Returns "free" if the org row does not exist.
 */
export async function readTier(orgId: string): Promise<string> {
  const db = globalThis.services.db;
  const [orgRow] = await db
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return orgRow?.tier ?? "free";
}

/**
 * Read org metadata from the platform-owned org_metadata table.
 * Returns tier, credits, and other platform fields.
 *
 * Unlike getOrgData(), this function NEVER calls the Clerk API —
 * it only reads from our own database.
 */
export async function getOrgMetadata(orgId: string): Promise<OrgMetadata> {
  const db = globalThis.services.db;
  const [row] = await db
    .select({ tier: orgMetadata.tier, credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return {
    orgId,
    tier: row?.tier ?? "free",
    credits: row?.credits ?? 0,
  };
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
    // In Stripe v2025 API, current_period_end was removed from Subscription.
    // Use the latest_invoice.period_end instead.
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
    if (subscription.latest_invoice) {
      const invoiceId =
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice.id;
      const latestInvoice = await stripe.invoices.retrieve(invoiceId);
      periodEnd = new Date(latestInvoice.period_end * 1000);

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
