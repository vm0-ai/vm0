import { getStripeClient } from "../external/stripe-client";

export const BILLING_RESTORE_PURPOSE = "billing_restore";
export const BILLING_DOWNGRADE_PURPOSE = "billing_downgrade";

interface BillingSubscriptionOrg {
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
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
  org: BillingSubscriptionOrg,
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

export async function billingDefaultPaymentMethodStatus(args: {
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly org: BillingSubscriptionOrg;
  readonly subscription?: unknown;
}): Promise<{ readonly ready: boolean; readonly customerId: string | null }> {
  if (!args.org.stripeSubscriptionId) {
    return { ready: false, customerId: args.org.stripeCustomerId };
  }

  const subscription =
    args.subscription ??
    (await args.stripe.subscriptions.retrieve(args.org.stripeSubscriptionId));
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

export async function createBillingSetupCheckout(args: {
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly purpose:
    | typeof BILLING_RESTORE_PURPOSE
    | typeof BILLING_DOWNGRADE_PURPOSE;
  readonly orgId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly returnUrl: string;
  readonly metadata?: Readonly<Record<string, string>>;
}): Promise<string> {
  const metadata = {
    purpose: args.purpose,
    orgId: args.orgId,
    subscriptionId: args.subscriptionId,
    ...args.metadata,
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
