import { command } from "ccstate";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { getStripeClient } from "../external/stripe-client";
import { activePriceId } from "./zero-billing-checkout.service";

const L = logger("BillingDowngrade");

const TIER_RANK = Object.freeze<Record<OrgTier, number>>({
  free: 0,
  pro: 1,
  team: 2,
});

type DowngradeResult =
  | { readonly ok: true; readonly effectiveDate: string | null }
  | { readonly ok: false; readonly reason: "no_subscription" }
  | {
      readonly ok: false;
      readonly reason: "invalid_target_tier";
      readonly currentTier: OrgTier;
      readonly targetTier: "free" | "pro";
    };

interface DowngradeArgs {
  readonly orgId: string;
  readonly targetTier: "free" | "pro";
}

/**
 * Downgrade an org's Stripe subscription. Verbatim port of apps/web's
 * `downgradeSubscription`. Two branches:
 * - `* → free`: schedules cancel-at-period-end and flips local
 *   `cancelAtPeriodEnd` flag. effectiveDate = currentPeriodEnd ISO string.
 * - `team → pro`: immediate tier swap via `stripe.subscriptions.update`
 *   with `proration_behavior: "always_invoice"`. effectiveDate = null.
 */
export const downgradeSubscription$ = command(
  async (
    { set },
    args: DowngradeArgs,
    signal: AbortSignal,
  ): Promise<DowngradeResult> => {
    const writeDb = set(writeDb$);

    const [org] = await writeDb
      .select({
        tier: orgMetadata.tier,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!org?.stripeSubscriptionId) {
      return { ok: false, reason: "no_subscription" };
    }

    const currentTier = org.tier as OrgTier;
    if (TIER_RANK[args.targetTier] >= TIER_RANK[currentTier]) {
      return {
        ok: false,
        reason: "invalid_target_tier",
        currentTier,
        targetTier: args.targetTier,
      };
    }

    const stripe = getStripeClient();

    if (args.targetTier === "free") {
      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
      signal.throwIfAborted();

      await writeDb
        .update(orgMetadata)
        .set({ cancelAtPeriodEnd: true, updatedAt: nowDate() })
        .where(eq(orgMetadata.orgId, args.orgId));
      signal.throwIfAborted();

      const effectiveDate = org.currentPeriodEnd?.toISOString() ?? null;
      L.debug("subscription cancellation initiated", {
        orgId: args.orgId,
        targetTier: args.targetTier,
        effectiveDate,
      });
      return { ok: true, effectiveDate };
    }

    const subscription = await stripe.subscriptions.retrieve(
      org.stripeSubscriptionId,
    );
    signal.throwIfAborted();

    const currentItem = subscription.items.data[0];
    if (!currentItem) {
      throw new Error("Subscription has no items");
    }

    const proPriceId = activePriceId("pro");
    if (!proPriceId) {
      throw new Error("Pro plan price ID not configured");
    }

    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      items: [{ id: currentItem.id, price: proPriceId }],
      proration_behavior: "always_invoice",
    });
    signal.throwIfAborted();

    L.debug("subscription downgraded", {
      orgId: args.orgId,
      from: currentTier,
      to: args.targetTier,
    });
    return { ok: true, effectiveDate: null };
  },
);
