import { command } from "ccstate";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Stripe } from "stripe";

import { env } from "../../lib/env";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface LockedCheckoutOrg {
  readonly orgId: string;
  readonly lastProcessedInvoiceId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly tier: string;
}

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

type PaidCheckoutInvoiceResult =
  | { readonly status: "completed" }
  | { readonly status: "pending" }
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

const CREDITS_PER_DOLLAR = 1000;
const STRIPE_SUBSCRIPTION_PRICE_TIERS = ["pro", "team"] as const;
export type SubscriptionCheckoutTier =
  (typeof STRIPE_SUBSCRIPTION_PRICE_TIERS)[number];

/** Returns the active (first) price ID for a given tier. */
export function activePriceId(
  tier: SubscriptionCheckoutTier,
): string | undefined {
  return env("ZERO_PRICE")?.[tier]?.[0];
}

export function tierFromPriceId(priceId: string): SubscriptionCheckoutTier {
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

function billingTierRank(tier: string | null | undefined): number {
  switch (tier) {
    case "team": {
      return 2;
    }
    case "pro": {
      return 1;
    }
    case "free":
    case "pro-suspend":
    default: {
      return 0;
    }
  }
}

function billingTierLabel(tier: string | null | undefined): string {
  switch (tier) {
    case "team": {
      return "Team";
    }
    case "pro": {
      return "Pro";
    }
    case "free": {
      return "Free";
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

export function activeCustomCreditPriceId(): string | undefined {
  return env("ZERO_PRICE")?.customCredits?.[0];
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

function subscriptionTrialEnd(subscription: Stripe.Subscription): Date | null {
  return typeof subscription.trial_end === "number"
    ? new Date(subscription.trial_end * 1000)
    : null;
}

function requiredSubscriptionTrialEnd(subscription: Stripe.Subscription): Date {
  const trialEnd = subscriptionTrialEnd(subscription);
  if (!trialEnd) {
    throw new Error(
      `trialing subscription has no trial_end (subscriptionId=${subscription.id})`,
    );
  }
  return trialEnd;
}

function monthlyCreditsForTier(tier: SubscriptionCheckoutTier): number {
  switch (tier) {
    case "pro": {
      return 20_000;
    }
    case "team": {
      return 120_000;
    }
  }
}

function subscriptionCreditExpiresAt(
  subscription: Stripe.Subscription,
  periodEndDate: Date,
): Date {
  if (subscription.status === "trialing") {
    return requiredSubscriptionTrialEnd(subscription);
  }

  const expiresAt = new Date(periodEndDate);
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  return expiresAt;
}

function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (typeof subscription === "string") {
    return subscription;
  }
  return subscription?.id ?? null;
}

function subscriptionPeriodEndFromInvoice(
  invoice: Stripe.Invoice,
): Date | null {
  const subscriptionLine = invoice.lines.data.find((line) => {
    return line.parent?.type === "subscription_item_details";
  });
  const periodEndUnix = subscriptionLine?.period.end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

async function latestPaidInvoice(
  stripe: ReturnType<typeof getStripeClient>,
  subscription: Stripe.Subscription,
): Promise<Stripe.Invoice | null> {
  const latestInvoice = subscription.latest_invoice;
  if (!latestInvoice) {
    return null;
  }

  const invoice =
    typeof latestInvoice === "string"
      ? await stripe.invoices.retrieve(latestInvoice)
      : latestInvoice;

  return invoice.status === "paid" ? invoice : null;
}

async function lockCheckoutOrg(
  tx: WriteTx,
  orgId: string,
): Promise<LockedCheckoutOrg | null> {
  const [org] = await tx
    .select({
      orgId: orgMetadata.orgId,
      lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .for("update")
    .limit(1);

  return org ?? null;
}

function invoiceWouldReplaceWithSameOrLowerTier(args: {
  readonly currentSubscriptionId: string | null;
  readonly subscriptionId: string;
  readonly currentTier: string;
  readonly targetTier: SubscriptionCheckoutTier;
}): boolean {
  return (
    args.currentSubscriptionId !== null &&
    args.currentSubscriptionId !== args.subscriptionId &&
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: args.currentTier,
      targetTier: args.targetTier,
    })
  );
}

async function expireCredits(tx: WriteTx, orgId: string): Promise<void> {
  const expired = await tx
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        lte(creditExpiresRecord.expiresAt, nowDate()),
        gt(creditExpiresRecord.remaining, 0),
      ),
    )
    .for("update");

  const totalExpired = expired.reduce((sum, record) => {
    return sum + record.remaining;
  }, 0);
  if (totalExpired === 0) {
    return;
  }

  for (const record of expired) {
    await tx
      .update(creditExpiresRecord)
      .set({ remaining: 0 })
      .where(eq(creditExpiresRecord.id, record.id));
  }

  await tx
    .update(orgMetadata)
    .set({
      credits: sql`GREATEST(${orgMetadata.credits} - ${totalExpired}, 0)`,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, orgId));
}

async function grantOrgCredits(
  tx: WriteTx,
  orgId: string,
  amount: number,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${amount}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits + ${amount}, updated_at = now()`,
  );
}

async function applyPaidCheckoutInvoice(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly invoice: Stripe.Invoice;
    readonly subscription: Stripe.Subscription;
    readonly tier: SubscriptionCheckoutTier;
    readonly periodEndDate: Date;
  },
): Promise<PaidCheckoutInvoiceResult> {
  const lockedOrg = await lockCheckoutOrg(tx, args.orgId);
  if (!lockedOrg) {
    return { status: "pending" };
  }

  if (lockedOrg.lastProcessedInvoiceId === args.invoice.id) {
    return { status: "completed" };
  }

  if (
    invoiceWouldReplaceWithSameOrLowerTier({
      currentSubscriptionId: lockedOrg.stripeSubscriptionId,
      subscriptionId: args.subscription.id,
      currentTier: lockedOrg.tier,
      targetTier: args.tier,
    })
  ) {
    return {
      status: "tier_conflict",
      currentTier: lockedOrg.tier,
      targetTier: args.tier,
    };
  }

  await expireCredits(tx, args.orgId);

  const credits = monthlyCreditsForTier(args.tier);
  const inserted = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId: args.orgId,
      source: "subscription_renewal",
      stripeInvoiceId: args.invoice.id,
      amount: credits,
      remaining: credits,
      expiresAt: subscriptionCreditExpiresAt(
        args.subscription,
        args.periodEndDate,
      ),
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });

  if (inserted.length > 0) {
    await grantOrgCredits(tx, args.orgId, credits);
  }

  await tx
    .update(orgMetadata)
    .set({
      tier: args.tier,
      stripeSubscriptionId: args.subscription.id,
      subscriptionStatus: args.subscription.status,
      cancelAtPeriodEnd: subscriptionWillCancel(args.subscription),
      onboardingPaymentPending: false,
      lastProcessedInvoiceId: args.invoice.id,
      currentPeriodEnd: args.periodEndDate,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, args.orgId));

  return { status: "completed" };
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

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice"],
    });
    signal.throwIfAborted();

    const priceId = subscription.items.data[0]?.price?.id;
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

    const paidInvoice = await latestPaidInvoice(stripe, subscription);
    signal.throwIfAborted();
    if (
      paidInvoice &&
      subscriptionIdFromInvoice(paidInvoice) === subscription.id
    ) {
      const periodEndDate = subscriptionPeriodEndFromInvoice(paidInvoice);
      if (!periodEndDate) {
        throw new Error(
          `checkout invoice has no subscription line item with period.end (invoiceId=${paidInvoice.id}, orgId=${args.orgId})`,
        );
      }

      const result = await db.transaction(async (tx) => {
        return await applyPaidCheckoutInvoice(tx, {
          orgId: args.orgId,
          invoice: paidInvoice,
          subscription,
          tier,
          periodEndDate,
        });
      });
      signal.throwIfAborted();
      return result;
    }

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
