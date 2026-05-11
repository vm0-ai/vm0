import { command, computed, type Computed } from "ccstate";
import type { AutoRechargeConfig } from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
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

type UpdateAutoRechargeResult =
  | { readonly ok: true; readonly data: AutoRechargeConfig }
  | { readonly ok: false; readonly error: string };

interface UpdateAutoRechargeArgs {
  readonly orgId: string;
  readonly enabled: boolean;
  readonly threshold?: number;
  readonly amount?: number;
}

export const updateAutoRechargeConfig$ = command(
  async (
    { set },
    args: UpdateAutoRechargeArgs,
    signal: AbortSignal,
  ): Promise<UpdateAutoRechargeResult> => {
    const { orgId, enabled, threshold, amount } = args;
    const writeDb = set(writeDb$);

    if (enabled) {
      const [row] = await writeDb
        .select({ tier: orgMetadata.tier })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      signal.throwIfAborted();

      const orgTier = row?.tier ?? "free";
      if (orgTier === "free") {
        return {
          ok: false,
          error: "Auto-recharge is only available for paid plans (Pro/Max)",
        };
      }
      if (threshold === undefined || amount === undefined) {
        return {
          ok: false,
          error:
            "threshold and amount are required when enabling auto-recharge",
        };
      }
      if (threshold >= amount) {
        return {
          ok: false,
          error: "threshold must be less than amount to avoid recharge loops",
        };
      }
    }

    await writeDb
      .update(orgMetadata)
      .set({
        autoRechargeEnabled: enabled,
        autoRechargeThreshold: enabled ? threshold : null,
        autoRechargeAmount: enabled ? amount : null,
        ...(!enabled ? { autoRechargePendingAt: null } : {}),
        updatedAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, orgId));
    signal.throwIfAborted();

    return {
      ok: true,
      data: {
        enabled,
        threshold: enabled ? (threshold ?? null) : null,
        amount: enabled ? (amount ?? null) : null,
      },
    };
  },
);
