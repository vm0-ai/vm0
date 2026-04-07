import { eq } from "drizzle-orm";
import type { OrgTier } from "@vm0/core";
import { getStripe } from "../stripe";
import { env } from "../../../env";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { grantOrgCredits } from "../org/org-service";
import { handleAutoRechargeInvoicePaid } from "./auto-recharge-service";
import { resetMemberCreditFlags } from "../credit/member-credit-cap-service";
import {
  createExpiresRecord,
  expireCredits,
  getExpiresRecordsSummary,
} from "../credit/credit-expires-service";
import { logger } from "../../shared/logger";

const log = logger("billing");

// ---------------------------------------------------------------------------
// Narrow input types — only the fields actually used by each handler.
// Accepts both string IDs and expanded Stripe objects (which have `.id`).
// ---------------------------------------------------------------------------

/** Fields read by {@link handleCheckoutCompleted}. */
interface CheckoutSessionInput {
  id: string;
  subscription: string | { id: string } | null;
  customer: string | { id: string } | null;
}

/** Fields read by {@link handleInvoicePaid}. */
interface InvoiceInput {
  id: string;
  customer: string | { id: string } | null;
  metadata: Record<string, string> | null;
  period_end?: number;
  parent: {
    subscription_details: {
      subscription: string | { id: string };
    } | null;
  } | null;
}

/** Fields read by {@link handleSubscriptionUpdated}. */
interface SubscriptionInput {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  items: { data: Array<{ price: { id: string } }> };
}

/** Fields read by {@link handleSubscriptionDeleted}. */
interface SubscriptionDeletedInput {
  id: string;
}

const TIER_MONTHLY_CREDITS: Record<OrgTier, number> = {
  free: 0,
  pro: 20_000,
  team: 120_000,
};

function tierFromPriceId(priceId: string): OrgTier {
  const priceMap = env().ZERO_PRICE;
  if (priceMap) {
    for (const [tier, ids] of Object.entries(priceMap)) {
      if (ids.includes(priceId)) return tier as OrgTier;
    }
  }
  throw new Error(`Unknown Stripe price ID: ${priceId}`);
}

/** Returns the active (first) price ID for a given tier. */
export function activePriceId(tier: "pro" | "team"): string | undefined {
  return env().ZERO_PRICE?.[tier]?.[0];
}

/**
 * Get or create a Stripe customer for an org.
 * Returns the Stripe customer ID.
 */
async function getOrCreateStripeCustomer(orgId: string): Promise<string> {
  const db = globalThis.services.db;
  const [row] = await db
    .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (row?.stripeCustomerId) {
    return row.stripeCustomerId;
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    metadata: { orgId },
  });

  await db
    .insert(orgMetadata)
    .values({ orgId, stripeCustomerId: customer.id })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { stripeCustomerId: customer.id, updatedAt: new Date() },
    });

  return customer.id;
}

/**
 * Create a Stripe Checkout session for subscription.
 * Returns the checkout session URL.
 */
export async function createCheckoutSession(
  orgId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId);
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: { orgId },
    },
  });

  if (!session.url) {
    throw new Error("Stripe checkout session did not return a URL");
  }

  return session.url;
}

/**
 * Handle checkout.session.completed — set tier + subscription fields on org.
 * Does NOT grant credits (single code path via invoice.paid).
 */
export async function handleCheckoutCompleted(
  session: CheckoutSessionInput,
): Promise<void> {
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (!subscriptionId) {
    log.warn("checkout.session.completed without subscription ID", {
      sessionId: session.id,
    });
    return;
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;

  if (!customerId) {
    log.warn("checkout.session.completed without customer ID", {
      sessionId: session.id,
    });
    return;
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;

  if (!priceId) {
    log.warn("subscription has no price ID", { subscriptionId });
    return;
  }

  const tier = tierFromPriceId(priceId);
  const db = globalThis.services.db;

  // Check idempotency: if subscription already stored, skip
  const [existing] = await db
    .select({ stripeSubscriptionId: orgMetadata.stripeSubscriptionId })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, customerId))
    .limit(1);

  if (existing?.stripeSubscriptionId === subscriptionId) {
    log.info("checkout.session.completed already processed", {
      subscriptionId,
    });
    return;
  }

  // In Stripe v2025 API, current_period_end was removed from Subscription.
  // Use the latest_invoice.period_end if available, otherwise leave null.
  let periodEnd: Date | undefined;
  if (subscription.latest_invoice) {
    const invoiceId =
      typeof subscription.latest_invoice === "string"
        ? subscription.latest_invoice
        : subscription.latest_invoice.id;
    const latestInvoice = await stripe.invoices.retrieve(invoiceId);
    periodEnd = new Date(latestInvoice.period_end * 1000);
  }

  await db
    .update(orgMetadata)
    .set({
      tier,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: false,
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      updatedAt: new Date(),
    })
    .where(eq(orgMetadata.stripeCustomerId, customerId));

  log.info("subscription activated via checkout", {
    tier,
    subscriptionId,
    customerId,
  });
}

/**
 * Handle invoice.paid — grant monthly credits (rollover).
 * Handles both initial subscription and renewals.
 * Idempotent: checks last_processed_invoice_id.
 */
export async function handleInvoicePaid(invoice: InvoiceInput): Promise<void> {
  // Handle auto-recharge invoices (identified by metadata) before subscription logic
  const handled = await handleAutoRechargeInvoicePaid(invoice);
  if (handled) return;

  // In Stripe v2025 API, subscription is under parent.subscription_details
  const subDetails = invoice.parent?.subscription_details;
  const subscriptionId = subDetails
    ? typeof subDetails.subscription === "string"
      ? subDetails.subscription
      : subDetails.subscription?.id
    : undefined;

  if (!subscriptionId) {
    log.warn("invoice.paid without subscription — skipping", {
      invoiceId: invoice.id,
    });
    return;
  }

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;

  if (!customerId) {
    log.warn("invoice.paid without customer ID", { invoiceId: invoice.id });
    return;
  }

  const db = globalThis.services.db;

  // Look up org by stripe_customer_id
  const [org] = await db
    .select({
      orgId: orgMetadata.orgId,
      lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, customerId))
    .limit(1);

  if (!org) {
    log.warn("invoice.paid for unknown customer", {
      customerId,
      invoiceId: invoice.id,
    });
    return;
  }

  // Idempotency: skip if this invoice was already processed
  if (org.lastProcessedInvoiceId === invoice.id) {
    log.info("invoice.paid already processed — skipping", {
      invoiceId: invoice.id,
      orgId: org.orgId,
    });
    return;
  }

  // Determine tier from subscription's price
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;

  if (!priceId) {
    log.warn("subscription has no price ID for credit grant", {
      subscriptionId,
    });
    return;
  }

  const tier = tierFromPriceId(priceId);
  const credits = TIER_MONTHLY_CREDITS[tier];

  if (credits <= 0) {
    log.warn("no credits to grant for tier", {
      tier,
      invoiceId: invoice.id,
      orgId: org.orgId,
    });
    return;
  }

  // Grant credits and mark invoice as processed in a transaction
  await db.transaction(async (tx) => {
    // Settle expired credits before granting new ones
    await expireCredits(tx, org.orgId);

    await grantOrgCredits(tx, org.orgId, credits);

    // Calculate expires_at: currentPeriodEnd + 1 month
    // invoice.period_end is required to create the expiry record correctly.
    // If it is missing, throw so the webhook fails and Stripe retries, alerting operators.
    const periodEndUnix = invoice.period_end;
    if (!periodEndUnix) {
      throw new Error(
        `invoice.paid missing period_end — cannot create expiry record (invoiceId=${invoice.id}, orgId=${org.orgId})`,
      );
    }

    const periodEndDate = new Date(periodEndUnix * 1000);
    const expiresAt = new Date(periodEndDate);
    expiresAt.setMonth(expiresAt.getMonth() + 1);

    await createExpiresRecord(tx, org.orgId, {
      source: "subscription_renewal",
      stripeInvoiceId: invoice.id,
      amount: credits,
      expiresAt,
    });

    await tx
      .update(orgMetadata)
      .set({
        lastProcessedInvoiceId: invoice.id,
        currentPeriodEnd: new Date(periodEndUnix * 1000),
        updatedAt: new Date(),
      })
      .where(eq(orgMetadata.orgId, org.orgId));
  });

  // Reset member credit cap flags for the new billing period
  await resetMemberCreditFlags(org.orgId);

  log.info("credits granted via invoice.paid", {
    orgId: org.orgId,
    credits,
    tier,
    invoiceId: invoice.id,
  });
}

/**
 * Handle customer.subscription.updated — sync status, period end, tier.
 */
export async function handleSubscriptionUpdated(
  subscription: SubscriptionInput,
): Promise<void> {
  const db = globalThis.services.db;

  const priceId = subscription.items.data[0]?.price?.id;

  // Determine tier from price ID if price changed (upgrade/downgrade via Billing Portal).
  // Unknown price IDs propagate as errors so Stripe retries the webhook,
  // alerting operators to a configuration mismatch.
  const tier: OrgTier | undefined = priceId
    ? tierFromPriceId(priceId)
    : undefined;

  await db
    .update(orgMetadata)
    .set({
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      updatedAt: new Date(),
      ...(tier ? { tier } : {}),
    })
    .where(eq(orgMetadata.stripeSubscriptionId, subscription.id));

  log.info("subscription updated", {
    subscriptionId: subscription.id,
    status: subscription.status,
  });
}

/**
 * Handle customer.subscription.deleted — downgrade to free.
 */
export async function handleSubscriptionDeleted(
  subscription: SubscriptionDeletedInput,
): Promise<void> {
  const db = globalThis.services.db;

  await db
    .update(orgMetadata)
    .set({
      tier: "free",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(orgMetadata.stripeSubscriptionId, subscription.id));

  log.info("subscription deleted — downgraded to free", {
    subscriptionId: subscription.id,
  });
}

// ---------------------------------------------------------------------------
// Tier ranking for downgrade validation
// ---------------------------------------------------------------------------

const TIER_RANK: Record<OrgTier, number> = {
  free: 0,
  pro: 1,
  team: 2,
};

/**
 * Downgrade a subscription to a lower tier.
 *
 * - Team -> Pro: updates the subscription's price via Stripe API (immediate).
 * - Paid -> Free: cancels the subscription at period end.
 *
 * Returns `{ success, effectiveDate }` where effectiveDate is non-null only
 * for cancellations (the date access ends).
 */
export async function downgradeSubscription(
  orgId: string,
  targetTier: "free" | "pro",
): Promise<{ success: boolean; effectiveDate: string | null }> {
  const db = globalThis.services.db;

  const [org] = await db
    .select({
      tier: orgMetadata.tier,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org?.stripeSubscriptionId) {
    throw new Error("Org has no active subscription");
  }

  const currentTier = org.tier as OrgTier;
  if (TIER_RANK[targetTier] >= TIER_RANK[currentTier]) {
    throw new Error(
      `Cannot downgrade from ${currentTier} to ${targetTier}: target tier is same or higher`,
    );
  }

  const stripe = getStripe();

  if (targetTier === "free") {
    // Cancel at period end
    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    await db
      .update(orgMetadata)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(orgMetadata.orgId, orgId));
    const effectiveDate = org.currentPeriodEnd
      ? org.currentPeriodEnd.toISOString()
      : null;
    log.info("subscription cancellation initiated", {
      orgId,
      targetTier,
      effectiveDate,
    });
    return { success: true, effectiveDate };
  }

  // Team -> Pro: update subscription price
  const subscription = await stripe.subscriptions.retrieve(
    org.stripeSubscriptionId,
  );
  const currentItem = subscription.items.data[0];
  if (!currentItem) {
    throw new Error("Subscription has no items");
  }

  const proPriceId = activePriceId("pro");
  if (!proPriceId) {
    throw new Error("Pro plan price ID not configured");
  }

  await stripe.subscriptions.update(org.stripeSubscriptionId, {
    items: [{ id: currentItem.id, price: proPriceId }],
    proration_behavior: "always_invoice",
  });

  log.info("subscription downgraded", {
    orgId,
    from: currentTier,
    to: targetTier,
  });
  return { success: true, effectiveDate: null };
}

/**
 * Create a Stripe Billing Portal session for managing subscriptions.
 * Returns the portal URL.
 */
export async function createBillingPortalSession(
  orgId: string,
  returnUrl: string,
): Promise<string> {
  const db = globalThis.services.db;
  const [org] = await db
    .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org?.stripeCustomerId) {
    throw new Error("Org has no Stripe customer — subscribe first");
  }

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: returnUrl,
  });

  return session.url;
}

/**
 * Get auto-recharge configuration for an org.
 */
export async function getAutoRechargeConfig(orgId: string): Promise<{
  enabled: boolean;
  threshold: number | null;
  amount: number | null;
}> {
  const db = globalThis.services.db;
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
}

/**
 * Update auto-recharge configuration for an org.
 * Validates tier and required fields when enabling.
 */
export async function updateAutoRechargeConfig(
  orgId: string,
  orgTier: string,
  config: { enabled: boolean; threshold?: number; amount?: number },
): Promise<
  | {
      ok: true;
      data: {
        enabled: boolean;
        threshold: number | null;
        amount: number | null;
      };
    }
  | { ok: false; error: string }
> {
  const { enabled, threshold, amount } = config;

  if (enabled) {
    if (orgTier === "free") {
      return {
        ok: false,
        error: "Auto-recharge is only available for paid plans (Pro/Max)",
      };
    }
    if (threshold === undefined || amount === undefined) {
      return {
        ok: false,
        error: "threshold and amount are required when enabling auto-recharge",
      };
    }
  }

  const db = globalThis.services.db;
  await db
    .update(orgMetadata)
    .set({
      autoRechargeEnabled: enabled,
      autoRechargeThreshold: enabled ? threshold : null,
      autoRechargeAmount: enabled ? amount : null,
      ...(!enabled ? { autoRechargePendingAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(orgMetadata.orgId, orgId));

  return {
    ok: true,
    data: {
      enabled,
      threshold: enabled ? (threshold ?? null) : null,
      amount: enabled ? (amount ?? null) : null,
    },
  };
}

/**
 * Get invoices for an org from Stripe.
 * Returns an empty array if the org has no Stripe customer.
 */
export async function getOrgInvoices(orgId: string): Promise<{
  invoices: Array<{
    id: string;
    number: string | null;
    date: number;
    amount: number;
    status: string | null;
    hostedInvoiceUrl: string | null;
  }>;
}> {
  const db = globalThis.services.db;
  const [row] = await db
    .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!row?.stripeCustomerId) {
    return { invoices: [] };
  }

  const stripe = getStripe();
  const result = await stripe.invoices.list({
    customer: row.stripeCustomerId,
    limit: 24,
  });

  const invoices = result.data.map((inv) => {
    return {
      id: inv.id,
      number: inv.number ?? null,
      date: inv.created,
      amount: inv.amount_paid ?? 0,
      status: inv.status ?? null,
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    };
  });

  return { invoices };
}

/**
 * Get billing status for an org.
 */
export async function getBillingStatus(orgId: string): Promise<{
  tier: string;
  credits: number;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
  autoRecharge: {
    enabled: boolean;
    threshold: number | null;
    amount: number | null;
  };
  creditExpiry: {
    expiringNextCycle: number;
    nextExpiryDate: Date | null;
  };
}> {
  const db = globalThis.services.db;
  const [org] = await db
    .select({
      tier: orgMetadata.tier,
      credits: orgMetadata.credits,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
      cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
      autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
      autoRechargeAmount: orgMetadata.autoRechargeAmount,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  const expirySummary = await getExpiresRecordsSummary(orgId);

  return {
    tier: org?.tier ?? "free",
    credits: org?.credits ?? 0,
    subscriptionStatus: org?.subscriptionStatus ?? null,
    currentPeriodEnd: org?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: org?.cancelAtPeriodEnd ?? false,
    hasSubscription: !!org?.stripeSubscriptionId,
    autoRecharge: {
      enabled: org?.autoRechargeEnabled ?? false,
      threshold: org?.autoRechargeThreshold ?? null,
      amount: org?.autoRechargeAmount ?? null,
    },
    creditExpiry: expirySummary,
  };
}
