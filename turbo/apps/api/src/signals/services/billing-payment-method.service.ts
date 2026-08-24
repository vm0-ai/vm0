import { getStripeClient } from "../external/stripe-client";
import {
  billingPreviewExpiresAt,
  createBillingPaymentMethodPreviewToken,
  type BillingPaymentMethodPreviewToken,
} from "./billing-purchase-preview-token.service";

export const BILLING_RESTORE_PURPOSE = "billing_restore";
export const BILLING_DOWNGRADE_PURPOSE = "billing_downgrade";
export const BILLING_PURCHASE_PURPOSE = "billing_purchase";

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

function subscriptionPaymentMethods(subscription: unknown): {
  readonly defaultPaymentMethodId: string | null;
  readonly defaultSourceId: string | null;
} {
  if (typeof subscription !== "object" || subscription === null) {
    return { defaultPaymentMethodId: null, defaultSourceId: null };
  }
  const record = subscription as {
    readonly default_payment_method?: unknown;
    readonly default_source?: unknown;
  };
  return {
    defaultPaymentMethodId: stripeObjectId(record.default_payment_method),
    defaultSourceId: stripeObjectId(record.default_source),
  };
}

function customerPaymentMethods(customer: unknown): {
  readonly defaultPaymentMethodId: string | null;
  readonly defaultSourceId: string | null;
} {
  if (typeof customer !== "object" || customer === null) {
    return { defaultPaymentMethodId: null, defaultSourceId: null };
  }
  if ("deleted" in customer && customer.deleted === true) {
    return { defaultPaymentMethodId: null, defaultSourceId: null };
  }

  const record = customer as {
    readonly invoice_settings?: {
      readonly default_payment_method?: unknown;
    } | null;
    readonly default_source?: unknown;
  };
  return {
    defaultPaymentMethodId: stripeObjectId(
      record.invoice_settings?.default_payment_method,
    ),
    defaultSourceId: stripeObjectId(record.default_source),
  };
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
  const route = await resolveBillingPurchaseRoute({
    stripe: args.stripe,
    supportsInAppPreview: true,
    customerId: args.org.stripeCustomerId,
    subscriptionId: args.org.stripeSubscriptionId,
    subscription: args.subscription,
  });
  return {
    ready: route.kind === "preview",
    customerId: route.customerId,
  };
}

export interface BillingPurchasePaymentMethod {
  readonly paymentMethodId: string;
  readonly paymentMethodType: "payment_method" | "source";
}

type BillingPurchaseRoute =
  | {
      readonly kind: "checkout";
      readonly customerId: string | null;
    }
  | (BillingPurchasePaymentMethod & {
      readonly kind: "preview";
      readonly customerId: string;
    });

export function stripeBillingPurchasePaymentParams(
  paymentMethod: BillingPurchasePaymentMethod,
):
  | { readonly default_payment_method: string }
  | { readonly default_source: string } {
  return paymentMethod.paymentMethodType === "payment_method"
    ? { default_payment_method: paymentMethod.paymentMethodId }
    : { default_source: paymentMethod.paymentMethodId };
}

export async function setStripeSubscriptionPaymentMethod(
  stripe: ReturnType<typeof getStripeClient>,
  subscriptionId: string,
  paymentMethod: BillingPurchasePaymentMethod,
  signal: AbortSignal,
): Promise<void> {
  await stripe.subscriptions.update(
    subscriptionId,
    stripeBillingPurchasePaymentParams(paymentMethod),
  );
  signal.throwIfAborted();
}

type BillingPurchasePreviewRoute = {
  readonly kind: "preview";
  readonly paymentMethodPreviewToken?: string;
};

export async function resolveBillingPurchaseRoute(
  args: {
    readonly stripe: ReturnType<typeof getStripeClient>;
    readonly supportsInAppPreview: boolean;
    readonly customerId: string | null;
    readonly subscriptionId?: string | null;
    readonly subscription?: unknown;
  },
  signal?: AbortSignal,
): Promise<BillingPurchaseRoute> {
  if (!args.supportsInAppPreview) {
    return { kind: "checkout", customerId: args.customerId };
  }

  const subscription = args.subscriptionId
    ? (args.subscription ??
      (await args.stripe.subscriptions.retrieve(args.subscriptionId)))
    : undefined;
  signal?.throwIfAborted();
  const subscriptionMethods = subscriptionPaymentMethods(subscription);
  const customerId = subscription
    ? subscriptionCustomerId(
        {
          stripeCustomerId: args.customerId,
          stripeSubscriptionId: args.subscriptionId ?? null,
        },
        subscription,
      )
    : args.customerId;
  if (subscriptionMethods.defaultPaymentMethodId && customerId) {
    return {
      kind: "preview",
      customerId,
      paymentMethodId: subscriptionMethods.defaultPaymentMethodId,
      paymentMethodType: "payment_method",
    };
  }

  if (!customerId) {
    return { kind: "checkout", customerId: null };
  }

  const customer = await args.stripe.customers.retrieve(customerId);
  signal?.throwIfAborted();
  const customerMethods = customerPaymentMethods(customer);
  if (customerMethods.defaultPaymentMethodId) {
    return {
      kind: "preview",
      customerId,
      paymentMethodId: customerMethods.defaultPaymentMethodId,
      paymentMethodType: "payment_method",
    };
  }

  const paymentMethods = await args.stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 1,
  });
  signal?.throwIfAborted();
  const attachedCardId = paymentMethods.data[0]?.id;
  if (attachedCardId) {
    return {
      kind: "preview",
      customerId,
      paymentMethodId: attachedCardId,
      paymentMethodType: "payment_method",
    };
  }

  const legacySourceId =
    subscriptionMethods.defaultSourceId ?? customerMethods.defaultSourceId;
  return legacySourceId
    ? {
        kind: "preview",
        customerId,
        paymentMethodId: legacySourceId,
        paymentMethodType: "source",
      }
    : { kind: "checkout", customerId };
}

export async function routeBillingPurchasePreview(
  args: {
    readonly stripe: ReturnType<typeof getStripeClient>;
    readonly orgId: string;
    readonly customerId: string | null;
    readonly subscriptionId: string;
    readonly operation: BillingPaymentMethodPreviewToken["operation"];
    readonly operationId: string;
    readonly returnUrl: string;
  },
  signal: AbortSignal,
): Promise<BillingPurchasePreviewRoute> {
  const route = await resolveBillingPurchaseRoute(
    {
      stripe: args.stripe,
      supportsInAppPreview: true,
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
    },
    signal,
  );
  if (route.kind === "checkout") {
    return { kind: "preview" };
  }
  return {
    kind: "preview",
    paymentMethodPreviewToken: createBillingPaymentMethodPreviewToken({
      version: 1,
      operation: args.operation,
      operationId: args.operationId,
      orgId: args.orgId,
      customerId: route.customerId,
      subscriptionId: args.subscriptionId,
      paymentMethodId: route.paymentMethodId,
      returnUrl: args.returnUrl,
      expiresAt: billingPreviewExpiresAt(),
    }),
  };
}

type RevalidatedBillingPurchase =
  | ({ readonly kind: "preview" } & BillingPurchasePaymentMethod)
  | { readonly kind: "hosted_invoice" }
  | { readonly kind: "invalid_preview" };

export async function revalidateBillingPurchase(
  args: {
    readonly stripe: ReturnType<typeof getStripeClient>;
    readonly orgId: string;
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly paymentMethodId: string;
    readonly operation: BillingPaymentMethodPreviewToken["operation"];
    readonly operationId: string;
    readonly returnUrl: string;
  },
  signal: AbortSignal,
): Promise<RevalidatedBillingPurchase> {
  const route = await resolveBillingPurchaseRoute(
    {
      stripe: args.stripe,
      supportsInAppPreview: true,
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
    },
    signal,
  );
  if (route.customerId !== args.customerId) {
    return { kind: "invalid_preview" };
  }
  if (route.kind === "checkout") {
    return { kind: "hosted_invoice" };
  }
  return route.paymentMethodId === args.paymentMethodId
    ? {
        kind: "preview",
        paymentMethodId: route.paymentMethodId,
        paymentMethodType: route.paymentMethodType,
      }
    : { kind: "invalid_preview" };
}

export async function createBillingSetupCheckout(args: {
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly purpose:
    | typeof BILLING_RESTORE_PURPOSE
    | typeof BILLING_DOWNGRADE_PURPOSE
    | typeof BILLING_PURCHASE_PURPOSE;
  readonly orgId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly returnUrl: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
}): Promise<string> {
  const metadata = {
    purpose: args.purpose,
    orgId: args.orgId,
    subscriptionId: args.subscriptionId,
    ...args.metadata,
  };
  const params = {
    mode: "setup",
    customer: args.customerId,
    currency: "usd",
    success_url: args.returnUrl,
    cancel_url: args.returnUrl,
    metadata,
    setup_intent_data: { metadata },
  } as const;
  const session = args.idempotencyKey
    ? await args.stripe.checkout.sessions.create(params, {
        idempotencyKey: args.idempotencyKey,
      })
    : await args.stripe.checkout.sessions.create(params);

  if (!session.url) {
    throw new Error("Stripe checkout session did not return a URL");
  }
  return session.url;
}
