import { command } from "ccstate";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";
import type { Stripe } from "stripe";

import { env } from "../../lib/env";
import { nowDate } from "../external/time";
import { writeDb$ } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";

interface CreateCheckoutSessionArgs {
  readonly orgId: string;
  readonly priceId: string;
  readonly trialDays?: 7;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly adAttribution?: Readonly<Record<string, string | undefined>>;
}

interface CompleteCheckoutSessionArgs {
  readonly orgId: string;
  readonly sessionId: string;
}

type CheckoutCompletionResult =
  | { readonly status: "completed" }
  | { readonly status: "pending" }
  | { readonly status: "customer_mismatch" };

interface CreateCreditCheckoutSessionArgs {
  readonly orgId: string;
  readonly credits: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

const CREDITS_PER_DOLLAR = 1000;
const STRIPE_SUBSCRIPTION_PRICE_TIERS = ["pro", "team"] as const;

/** Returns the active (first) price ID for a given tier. */
export function activePriceId(tier: "pro" | "team"): string | undefined {
  return env("ZERO_PRICE")?.[tier]?.[0];
}

export function tierFromPriceId(priceId: string): OrgTier {
  const priceMap = env("ZERO_PRICE");
  if (priceMap) {
    for (const tier of STRIPE_SUBSCRIPTION_PRICE_TIERS) {
      if (priceMap[tier]?.includes(priceId)) {
        return tier;
      }
    }
  }
  throw new Error(`Unknown Stripe price ID: ${priceId}`);
}

export function activeCustomCreditPriceId(): string | undefined {
  return env("ZERO_PRICE")?.customCredits?.[0];
}

function checkoutSessionMetadata(
  orgId: string,
  adAttribution: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const metadata: Record<string, string> = { orgId };
  for (const [key, value] of Object.entries(adAttribution ?? {})) {
    if (value) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function stripeObjectId(
  value: string | { readonly id: string } | null | undefined,
): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.id ?? null;
}

function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const periodEndUnix = subscription.items.data[0]?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function customUnitAmountParams(
  template: Stripe.Price.CustomUnitAmount | null,
  preset: number,
): Stripe.PriceCreateParams.CustomUnitAmount {
  return {
    enabled: true,
    preset,
    ...(template?.minimum === null || template?.minimum === undefined
      ? {}
      : { minimum: template.minimum }),
    ...(template?.maximum === null || template?.maximum === undefined
      ? {}
      : { maximum: template.maximum }),
  };
}

async function createPresetCustomCreditPrice(
  stripe: ReturnType<typeof getStripeClient>,
  templatePriceId: string,
  presetAmountCents: number,
): Promise<string> {
  const templatePrice = await stripe.prices.retrieve(templatePriceId);
  const productId =
    typeof templatePrice.product === "string"
      ? templatePrice.product
      : templatePrice.product.id;
  const customPrice = await stripe.prices.create({
    currency: templatePrice.currency,
    product: productId,
    custom_unit_amount: customUnitAmountParams(
      templatePrice.custom_unit_amount,
      presetAmountCents,
    ),
  });
  return customPrice.id;
}

/**
 * Create a Stripe Checkout session for subscription. Returns the
 * checkout session URL. Mirrors apps/web's createCheckoutSession
 * (allow_promotion_codes + subscription metadata orgId tag).
 */
export const createCheckoutSession$ = command(
  async (
    { set },
    args: CreateCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const customerId = await set(
      getOrCreateStripeCustomer$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const metadata = checkoutSessionMetadata(args.orgId, args.adAttribution);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: args.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata,
      subscription_data: {
        metadata,
        ...(args.trialDays === undefined
          ? {}
          : { trial_period_days: args.trialDays }),
      },
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);

export const completeCheckoutSession$ = command(
  async (
    { set },
    args: CompleteCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<CheckoutCompletionResult> => {
    const db = set(writeDb$);
    const [org] = await db
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(args.sessionId);
    signal.throwIfAborted();

    const customerId = stripeObjectId(session.customer);
    if (!customerId || customerId !== org?.stripeCustomerId) {
      return { status: "customer_mismatch" };
    }

    if (session.status !== "complete" || session.mode !== "subscription") {
      return { status: "pending" };
    }

    const subscriptionId = stripeObjectId(session.subscription);
    if (!subscriptionId) {
      return { status: "pending" };
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    signal.throwIfAborted();

    const priceId = subscription.items.data[0]?.price?.id;
    if (!priceId) {
      return { status: "pending" };
    }

    const tier = tierFromPriceId(priceId);
    const periodEnd = subscriptionPeriodEnd(subscription);

    await db
      .update(orgMetadata)
      .set({
        tier,
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        onboardingPaymentPending: false,
        ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgMetadata.orgId, args.orgId),
          eq(orgMetadata.stripeCustomerId, customerId),
        ),
      );
    signal.throwIfAborted();

    return { status: "completed" };
  },
);

export const createCreditCheckoutSession$ = command(
  async (
    { set },
    args: CreateCreditCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const customerId = await set(
      getOrCreateStripeCustomer$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const baseMetadata = {
      purpose: "credit_purchase",
      orgId: args.orgId,
    };
    const customCreditPriceId = activeCustomCreditPriceId();
    if (!customCreditPriceId) {
      throw new Error("Custom credit price not configured");
    }
    const presetAmountCents =
      Math.ceil(args.credits / CREDITS_PER_DOLLAR) * 100;
    const presetPriceId = await createPresetCustomCreditPrice(
      stripe,
      customCreditPriceId,
      presetAmountCents,
    );
    signal.throwIfAborted();
    const metadata: Stripe.MetadataParam = {
      ...baseMetadata,
      creditsAmountMode: "amount_subtotal",
      requestedCreditsAmount: String(args.credits),
    };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: presetPriceId, quantity: 1 }],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: {
          type: "credit_purchase",
          ...metadata,
        },
      },
      metadata,
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);
