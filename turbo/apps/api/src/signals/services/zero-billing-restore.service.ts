import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { getStripeClient } from "../external/stripe-client";

const L = logger("BillingRestore");
const BILLING_RESTORE_PURPOSE = "billing_restore";

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

interface RestoreOrgRow {
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pendingSubscriptionScheduleId: string | null;
  readonly pendingSubscriptionTargetTier: string | null;
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return null;
  }

  const record = value as { readonly id?: unknown };
  return typeof record.id === "string" ? record.id : null;
}

function subscriptionDefaultPaymentMethodId(
  subscription: unknown,
): string | null {
  if (typeof subscription !== "object" || subscription === null) {
    return null;
  }
  const record = subscription as {
    readonly default_payment_method?: unknown;
    readonly default_source?: unknown;
  };
  return (
    stripeObjectId(record.default_payment_method) ??
    stripeObjectId(record.default_source)
  );
}

function customerDefaultPaymentMethodId(customer: unknown): string | null {
  if (typeof customer !== "object" || customer === null) {
    return null;
  }
  if ("deleted" in customer && customer.deleted === true) {
    return null;
  }

  const record = customer as {
    readonly invoice_settings?: {
      readonly default_payment_method?: unknown;
    } | null;
    readonly default_source?: unknown;
  };
  return (
    stripeObjectId(record.invoice_settings?.default_payment_method) ??
    stripeObjectId(record.default_source)
  );
}

function subscriptionCustomerId(
  org: RestoreOrgRow,
  subscription: unknown,
): string | null {
  if (org.stripeCustomerId) {
    return org.stripeCustomerId;
  }
  if (typeof subscription !== "object" || subscription === null) {
    return null;
  }
  const record = subscription as { readonly customer?: unknown };
  return stripeObjectId(record.customer);
}

async function hasDefaultPaymentMethod(args: {
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly org: RestoreOrgRow;
}): Promise<{ readonly ready: boolean; readonly customerId: string | null }> {
  if (!args.org.stripeSubscriptionId) {
    return { ready: false, customerId: args.org.stripeCustomerId };
  }

  const subscription = await args.stripe.subscriptions.retrieve(
    args.org.stripeSubscriptionId,
  );
  if (subscriptionDefaultPaymentMethodId(subscription)) {
    return {
      ready: true,
      customerId: subscriptionCustomerId(args.org, subscription),
    };
  }

  const customerId = subscriptionCustomerId(args.org, subscription);
  if (!customerId) {
    return { ready: false, customerId: null };
  }

  const customer = await args.stripe.customers.retrieve(customerId);
  return {
    ready: customerDefaultPaymentMethodId(customer) !== null,
    customerId,
  };
}

async function createRestorePaymentMethodCheckout(args: {
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly orgId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly returnUrl: string;
}): Promise<string> {
  const metadata = {
    purpose: BILLING_RESTORE_PURPOSE,
    orgId: args.orgId,
    subscriptionId: args.subscriptionId,
  };
  const session = await args.stripe.checkout.sessions.create({
    mode: "setup",
    customer: args.customerId,
    currency: "usd",
    success_url: args.returnUrl,
    cancel_url: args.returnUrl,
    metadata,
    setup_intent_data: { metadata },
  });

  if (!session.url) {
    throw new Error("Stripe checkout session did not return a URL");
  }
  return session.url;
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
    const paymentMethod = await hasDefaultPaymentMethod({ stripe, org });
    if (!paymentMethod.ready) {
      if (!paymentMethod.customerId) {
        throw new Error("Stripe subscription has no customer for restore");
      }
      if (!args.returnUrl) {
        throw new Error("returnUrl is required to collect a payment method");
      }

      const checkoutUrl = await createRestorePaymentMethodCheckout({
        stripe,
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
