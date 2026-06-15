import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { getStripeClient } from "../external/stripe-client";
import {
  BILLING_RESTORE_PURPOSE,
  billingDefaultPaymentMethodStatus,
  createBillingSetupCheckout,
} from "./zero-billing-payment-method.service";

const L = logger("BillingRestore");

type RestoreResult =
  | { readonly ok: true; readonly status: "restored" }
  | {
      readonly ok: true;
      readonly status: "payment_method_required";
      readonly checkoutUrl: string;
    }
  | { readonly ok: false; readonly reason: "no_subscription" }
  | { readonly ok: false; readonly reason: "not_scheduled" };

interface RestoreArgs {
  readonly orgId: string;
  readonly returnUrl: string;
}

interface RestoreSubscriptionForOrgArgs {
  readonly orgId: string;
  readonly returnUrl?: string;
  readonly requirePaymentMethod?: boolean;
}

export async function restoreSubscriptionForOrg(
  db: Db,
  args: RestoreSubscriptionForOrgArgs,
): Promise<RestoreResult> {
  const [org] = await db
    .select({
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
      pendingSubscriptionScheduleId: orgMetadata.pendingSubscriptionScheduleId,
      pendingSubscriptionTargetTier: orgMetadata.pendingSubscriptionTargetTier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);

  if (!org?.stripeSubscriptionId) {
    return { ok: false, reason: "no_subscription" };
  }

  const pendingScheduleId = org.pendingSubscriptionScheduleId;
  if (!org.cancelAtPeriodEnd && !pendingScheduleId) {
    return { ok: false, reason: "not_scheduled" };
  }

  const stripe = getStripeClient();
  if (args.requirePaymentMethod !== false) {
    const paymentMethod = await billingDefaultPaymentMethodStatus({
      stripe,
      org,
    });
    if (!paymentMethod.ready) {
      if (!paymentMethod.customerId) {
        throw new Error("Stripe subscription has no customer for restore");
      }
      if (!args.returnUrl) {
        throw new Error("returnUrl is required to collect a payment method");
      }

      const checkoutUrl = await createBillingSetupCheckout({
        stripe,
        purpose: BILLING_RESTORE_PURPOSE,
        orgId: args.orgId,
        customerId: paymentMethod.customerId,
        subscriptionId: org.stripeSubscriptionId,
        returnUrl: args.returnUrl,
      });
      return { ok: true, status: "payment_method_required", checkoutUrl };
    }
  }

  if (pendingScheduleId) {
    await stripe.subscriptionSchedules.release(pendingScheduleId);
  } else {
    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
  }

  await db
    .update(orgMetadata)
    .set({
      cancelAtPeriodEnd: false,
      pendingSubscriptionScheduleId: null,
      pendingSubscriptionTargetTier: null,
      pendingSubscriptionChangeAt: null,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, args.orgId));

  L.debug("scheduled subscription change restored", {
    orgId: args.orgId,
    stripeSubscriptionId: org.stripeSubscriptionId,
    pendingSubscriptionTargetTier: org.pendingSubscriptionTargetTier,
  });

  return { ok: true, status: "restored" };
}

export const restoreSubscription$ = command(
  async (
    { set },
    args: RestoreArgs,
    signal: AbortSignal,
  ): Promise<RestoreResult> => {
    const writeDb = set(writeDb$);
    const result = await restoreSubscriptionForOrg(writeDb, args);
    signal.throwIfAborted();

    return result;
  },
);
