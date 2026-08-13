import { command } from "ccstate";
import type {
  ConcurrencySubscriptionChangePreviewResponse,
  UsagePackUsd,
} from "@okouai/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/schema/org-plan-entitlement";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type ReadonlyDb } from "../external/db";
import {
  getStripeClient,
  type StripeMetadataParam,
  type StripeSubscription,
} from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { persistOrgAcquisitionAttribution$ } from "./acquisition-attribution.service";
import {
  addStripeConcurrencySubscriptionItem$,
  applyStripeConcurrencySubscriptionChange$,
  previewStripeConcurrencySubscriptionChange$,
} from "./zero-billing-concurrency-subscription.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";

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
  readonly hasScheduledConcurrencyChange: boolean;
  readonly successUrl: string;
}

type StartConcurrencyPurchaseResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_quantity"
        | "missing_plan_subscription"
        | "pending_update";
    };

type PreviewInitialConcurrencyPurchaseResult =
  | {
      readonly ok: true;
      readonly preview: ConcurrencySubscriptionChangePreviewResponse;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_quantity"
        | "missing_plan_subscription"
        | "not_found"
        | "canceling"
        | "no_change"
        | "pending_update";
    };

const CREDITS_PER_DOLLAR = 1000;
const STRIPE_SUBSCRIPTION_PRICE_TIERS = ["pro", "team"] as const;
export type SubscriptionCheckoutTier =
  (typeof STRIPE_SUBSCRIPTION_PRICE_TIERS)[number];

async function orgPlanSubscriptionId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [plan] = await db
    .select({
      stripeSubscriptionId: orgPlanEntitlements.stripeSubscriptionId,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  return plan?.stripeSubscriptionId ?? null;
}

function legacyPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] | undefined {
  switch (tier) {
    case "pro": {
      return env("OKOU_PRICE_PRO");
    }
    case "team": {
      return env("OKOU_PRICE_TEAM");
    }
  }
}

function usagePackPlanPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] | undefined {
  switch (tier) {
    case "pro": {
      return env("OKOU_PRICE_USAGE_PACK_PLAN_PRO");
    }
    case "team": {
      return env("OKOU_PRICE_USAGE_PACK_PLAN_TEAM");
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
      return env("OKOU_PRICE_USAGE_PACK_20") ?? [];
    }
    case 50: {
      return env("OKOU_PRICE_USAGE_PACK_50") ?? [];
    }
    case 100: {
      return env("OKOU_PRICE_USAGE_PACK_100") ?? [];
    }
    case 200: {
      return env("OKOU_PRICE_USAGE_PACK_200") ?? [];
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
  return env("OKOU_PRICE_CUSTOM_CREDIT_UNIT");
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

function subscriptionWillCancel(subscription: StripeSubscription): boolean {
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
    await set(
      persistOrgAcquisitionAttribution$,
      { orgId: args.orgId, attribution: args.adAttribution },
      signal,
    );
    signal.throwIfAborted();

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
    const metadata: StripeMetadataParam = {
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

export const previewInitialConcurrencyPurchase$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly priceId: string;
      readonly quantity: number;
    },
    signal: AbortSignal,
  ): Promise<PreviewInitialConcurrencyPurchaseResult> => {
    const subscriptionId = await orgPlanSubscriptionId(
      set(writeDb$),
      args.orgId,
    );
    signal.throwIfAborted();
    if (!subscriptionId) {
      return { ok: false, reason: "missing_plan_subscription" };
    }
    return await set(
      previewStripeConcurrencySubscriptionChange$,
      {
        subscriptionId,
        priceId: args.priceId,
        quantity: args.quantity,
        mode: "absolute",
        hasScheduledConcurrencyChange: false,
      },
      signal,
    );
  },
);

export const startConcurrencyPurchase$ = command(
  async (
    { set },
    args: StartConcurrencyPurchaseArgs,
    signal: AbortSignal,
  ): Promise<StartConcurrencyPurchaseResult> => {
    // Old web/app clients can send existing subscriptions through this legacy
    // checkout endpoint for the ~2-day client version-skew window. Remove this
    // branch with #26152 after #26116 has been deployed beyond that window.
    if (args.existingSubscriptionId) {
      const result = await set(
        applyStripeConcurrencySubscriptionChange$,
        {
          subscriptionId: args.existingSubscriptionId,
          quantity: args.quantity,
          mode: "increase",
          hasScheduledConcurrencyChange: args.hasScheduledConcurrencyChange,
        },
        signal,
      );
      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.reason === "invalid_quantity"
              ? "invalid_quantity"
              : "pending_update",
        };
      }
      return {
        ok: true,
        url:
          result.response.status === "pending_payment"
            ? result.response.hostedInvoiceUrl
            : args.successUrl,
      };
    }

    const subscriptionId = await orgPlanSubscriptionId(
      set(writeDb$),
      args.orgId,
    );
    signal.throwIfAborted();
    if (!subscriptionId) {
      return { ok: false, reason: "missing_plan_subscription" };
    }

    const result = await set(
      addStripeConcurrencySubscriptionItem$,
      {
        subscriptionId,
        priceId: args.priceId,
        quantity: args.quantity,
      },
      signal,
    );
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      url:
        result.response.status === "pending_payment"
          ? result.response.hostedInvoiceUrl
          : args.successUrl,
    };
  },
);
