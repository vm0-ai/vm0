import { command } from "ccstate";
import type { UsagePackUsd } from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";
import type { Stripe } from "stripe";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  CONCURRENCY_SUBSCRIPTION_PURPOSE,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";

interface CreateCheckoutSessionArgs {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
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
  | { readonly status: "customer_mismatch" }
  | {
      readonly status: "tier_conflict";
      readonly currentTier: string | null;
      readonly targetTier: SubscriptionCheckoutTier;
    };

interface CreateCreditCheckoutSessionArgs {
  readonly orgId: string;
  readonly credits: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

interface StartConcurrencyPurchaseArgs {
  readonly orgId: string;
  readonly quantity: number;
  readonly priceId: string;
  readonly existingSubscriptionId?: string;
  readonly portalConfigurationId?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

const CREDITS_PER_DOLLAR = 1000;
const STRIPE_SUBSCRIPTION_PRICE_TIERS = ["pro", "team"] as const;
export type SubscriptionCheckoutTier =
  (typeof STRIPE_SUBSCRIPTION_PRICE_TIERS)[number];

function legacyPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] | undefined {
  switch (tier) {
    case "pro": {
      return env("ZERO_PRICE_PRO");
    }
    case "team": {
      return env("ZERO_PRICE_TEAM");
    }
  }
}

function usagePackPlanPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] | undefined {
  switch (tier) {
    case "pro": {
      return env("ZERO_PRICE_USAGE_PACK_PLAN_PRO");
    }
    case "team": {
      return env("ZERO_PRICE_USAGE_PACK_PLAN_TEAM");
    }
  }
}

function knownPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] {
  return [
    ...(legacyPriceIdsForTier(tier) ?? []),
    ...(usagePackPlanPriceIdsForTier(tier) ?? []),
  ];
}

/** Returns the active (first) price ID for a given tier. */
export function activePriceId(
  tier: SubscriptionCheckoutTier,
): string | undefined {
  return legacyPriceIdsForTier(tier)?.[0];
}

export function activeUsagePackPlanPriceId(
  tier: SubscriptionCheckoutTier,
): string | undefined {
  return usagePackPlanPriceIdsForTier(tier)?.[0];
}

function usagePackPriceIds(usagePackUsd: UsagePackUsd): readonly string[] {
  switch (usagePackUsd) {
    case 20: {
      return env("ZERO_PRICE_USAGE_PACK_20") ?? [];
    }
    case 50: {
      return env("ZERO_PRICE_USAGE_PACK_50") ?? [];
    }
    case 100: {
      return env("ZERO_PRICE_USAGE_PACK_100") ?? [];
    }
    case 200: {
      return env("ZERO_PRICE_USAGE_PACK_200") ?? [];
    }
  }
}

export function activeUsagePackPriceId(
  usagePackUsd: UsagePackUsd,
): string | undefined {
  return usagePackPriceIds(usagePackUsd)[0];
}

export function usagePackUsdForKnownPriceId(
  priceId: string,
): UsagePackUsd | null {
  for (const usagePackUsd of [20, 50, 100, 200] as const) {
    if (usagePackPriceIds(usagePackUsd).includes(priceId)) {
      return usagePackUsd;
    }
  }
  return null;
}

export function isUsagePackPlanPriceId(priceId: string): boolean {
  return STRIPE_SUBSCRIPTION_PRICE_TIERS.some((tier) => {
    return usagePackPlanPriceIdsForTier(tier)?.includes(priceId) ?? false;
  });
}

export function tierForKnownPriceId(
  priceId: string,
): SubscriptionCheckoutTier | null {
  for (const tier of STRIPE_SUBSCRIPTION_PRICE_TIERS) {
    if (knownPriceIdsForTier(tier).includes(priceId)) {
      return tier;
    }
  }
  return null;
}

interface PlanPriceItem {
  readonly price: { readonly id: string };
}

export function knownPlanPriceItem<T extends PlanPriceItem>(
  items: readonly T[],
): T | undefined {
  return items.find((item) => {
    return tierForKnownPriceId(item.price.id) !== null;
  });
}

export function tierFromPriceId(priceId: string): SubscriptionCheckoutTier {
  const tier = tierForKnownPriceId(priceId);
  if (tier) {
    return tier;
  }
  throw new Error(`Unknown Stripe price ID: ${priceId}`);
}

function billingTierRank(tier: string | null | undefined): number {
  switch (tier) {
    case "custom": {
      return 3;
    }
    case "team": {
      return 2;
    }
    case "pro": {
      return 1;
    }
    case "free":
    case "limited-free-1":
    case "pro-suspend":
    default: {
      return 0;
    }
  }
}

function billingTierLabel(tier: string | null | undefined): string {
  switch (tier) {
    case "custom": {
      return "Custom";
    }
    case "team": {
      return "Team";
    }
    case "pro": {
      return "Pro";
    }
    case "free": {
      return "Free";
    }
    case "limited-free-1": {
      return "Limited free";
    }
    case "pro-suspend": {
      return "Pro suspended";
    }
    default: {
      return tier ?? "Pro suspended";
    }
  }
}

export function checkoutWouldReplaceWithSameOrLowerTier(args: {
  readonly currentTier: string | null | undefined;
  readonly targetTier: SubscriptionCheckoutTier;
}): boolean {
  return billingTierRank(args.currentTier) >= billingTierRank(args.targetTier);
}

export function checkoutTierConflictMessage(args: {
  readonly currentTier: string | null | undefined;
  readonly targetTier: SubscriptionCheckoutTier;
}): string {
  return `Cannot create ${billingTierLabel(args.targetTier)} checkout while current tier is ${billingTierLabel(args.currentTier)}; use billing management to change plans`;
}

export function activeCustomCreditUnitPriceId(): string | undefined {
  return env("ZERO_PRICE_CUSTOM_CREDIT_UNIT");
}

function checkoutSessionMetadata(args: {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly priceId: string;
  readonly adAttribution:
    | Readonly<Record<string, string | undefined>>
    | undefined;
}): Record<string, string> {
  const metadata: Record<string, string> = {
    orgId: args.orgId,
    tier: args.tier,
    priceId: args.priceId,
  };
  for (const [key, value] of Object.entries(args.adAttribution ?? {})) {
    if (value) {
      metadata[key] = value;
    }
  }
  Object.assign(metadata, stripePreviewMetadata());
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

function subscriptionWillCancel(subscription: Stripe.Subscription): boolean {
  return subscription.cancel_at_period_end || subscription.cancel_at !== null;
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
    const metadata = checkoutSessionMetadata({
      orgId: args.orgId,
      tier: args.tier,
      priceId: args.priceId,
      adAttribution: args.adAttribution,
    });
    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId, metadata: args.adAttribution },
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
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
      .select({
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        tier: orgMetadata.tier,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(args.sessionId);
    signal.throwIfAborted();

    const customerId = stripeObjectId(session.customer);
    if (!org || !customerId || customerId !== org.stripeCustomerId) {
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

    const priceId = knownPlanPriceItem(subscription.items.data)?.price.id;
    if (!priceId) {
      return { status: "pending" };
    }

    const tier = tierFromPriceId(priceId);
    if (
      org.stripeSubscriptionId !== subscription.id &&
      checkoutWouldReplaceWithSameOrLowerTier({
        currentTier: org.tier,
        targetTier: tier,
      })
    ) {
      return {
        status: "tier_conflict",
        currentTier: org.tier,
        targetTier: tier,
      };
    }
    const alreadyPaidSubscription =
      org.stripeSubscriptionId === subscription.id && org.tier === tier;

    await db
      .update(orgMetadata)
      .set({
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscriptionWillCancel(subscription),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgMetadata.orgId, args.orgId),
          eq(orgMetadata.stripeCustomerId, customerId),
        ),
      );
    signal.throwIfAborted();

    return { status: alreadyPaidSubscription ? "completed" : "pending" };
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
      { orgId: args.orgId },
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const customer = await stripe.customers.retrieve(customerId);
    signal.throwIfAborted();
    const customerCoupon =
      "discount" in customer ? customer.discount?.source.coupon : null;
    const customerCouponId =
      typeof customerCoupon === "string" ? customerCoupon : customerCoupon?.id;
    const baseMetadata = {
      purpose: "credit_purchase",
      orgId: args.orgId,
      ...stripePreviewMetadata(),
    };
    const customCreditUnitPriceId = activeCustomCreditUnitPriceId();
    if (!customCreditUnitPriceId) {
      throw new Error("Custom credit price not configured");
    }
    const unitQuantity = Math.ceil(args.credits / CREDITS_PER_DOLLAR);
    const metadata: Stripe.MetadataParam = {
      ...baseMetadata,
      creditsAmountMode: "amount_subtotal",
      requestedCreditsAmount: String(args.credits),
    };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: customCreditUnitPriceId, quantity: unitQuantity }],
      ...(customerCouponId
        ? { discounts: [{ coupon: customerCouponId }] }
        : { allow_promotion_codes: true }),
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata: {
            type: "credit_purchase",
            ...metadata,
          },
        },
      },
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

function expandedLatestInvoice(
  subscription: Stripe.Subscription,
): Stripe.Invoice | null {
  return typeof subscription.latest_invoice === "string"
    ? null
    : subscription.latest_invoice;
}

function concurrencySubscriptionItem(subscription: Stripe.Subscription): {
  readonly id: string;
  readonly quantity: number;
} {
  const item = subscription.items.data.find((candidate) => {
    return isConcurrencyPriceId(candidate.price.id);
  });
  if (!item || !item.quantity) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  return { id: item.id, quantity: item.quantity };
}

export const startConcurrencyPurchase$ = command(
  async (
    { set },
    args: StartConcurrencyPurchaseArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const stripe = getStripeClient();
    if (args.existingSubscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(
        args.existingSubscriptionId,
        { expand: ["latest_invoice"] },
      );
      signal.throwIfAborted();

      const pendingInvoice = expandedLatestInvoice(subscription);
      if (subscription.pending_update) {
        if (!pendingInvoice?.hosted_invoice_url) {
          throw new Error(
            "Pending concurrency subscription update has no hosted invoice URL",
          );
        }
        return pendingInvoice.hosted_invoice_url;
      }

      const item = concurrencySubscriptionItem(subscription);
      if (!args.portalConfigurationId) {
        throw new Error(
          "Concurrency billing portal configuration is not configured",
        );
      }
      const customerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id;
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        configuration: args.portalConfigurationId,
        return_url: args.cancelUrl,
        flow_data: {
          type: "subscription_update_confirm",
          after_completion: {
            type: "redirect",
            redirect: { return_url: args.successUrl },
          },
          subscription_update_confirm: {
            subscription: subscription.id,
            items: [{ id: item.id, quantity: item.quantity + args.quantity }],
          },
        },
      });
      signal.throwIfAborted();
      return session.url;
    }

    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId },
      signal,
    );
    signal.throwIfAborted();

    const metadata: Stripe.MetadataParam = {
      purpose: CONCURRENCY_SUBSCRIPTION_PURPOSE,
      orgId: args.orgId,
      priceId: args.priceId,
      quantity: String(args.quantity),
      ...stripePreviewMetadata(),
    };
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: args.priceId, quantity: args.quantity }],
      allow_promotion_codes: true,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata,
      subscription_data: {
        metadata,
      },
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);
