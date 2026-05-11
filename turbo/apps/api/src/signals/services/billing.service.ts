import { command, computed, type Computed } from "ccstate";
import type { AutoRechargeConfig } from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { getStripeClient } from "../external/stripe-client";

export function autoRechargeConfig(
  orgId: string,
): Computed<Promise<AutoRechargeConfig>> {
  return computed(async (get): Promise<AutoRechargeConfig> => {
    const db = get(db$);
    const [row] = await db
      .select({
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return {
      enabled: row?.autoRechargeEnabled ?? false,
      threshold: row?.autoRechargeThreshold ?? null,
      amount: row?.autoRechargeAmount ?? null,
    };
  });
}

/**
 * Create a Stripe Billing Portal session for managing subscriptions.
 * Mirrors apps/web's `createBillingPortalSession`. Returns the portal URL.
 *
 * Throws if the org has no Stripe customer yet (defensive — web's
 * tests don't exercise this branch either; framework returns 500).
 */
export const createBillingPortalSession$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly returnUrl: string },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = get(db$);
    const [org] = await db
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!org?.stripeCustomerId) {
      throw new Error("Org has no Stripe customer — subscribe first");
    }

    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: args.returnUrl,
    });
    signal.throwIfAborted();

    return session.url;
  },
);
