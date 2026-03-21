import { eq } from "drizzle-orm";
import type { OrgTier } from "@vm0/core";
import { getStripe } from "../stripe";
import { env } from "../../env";
import { orgMetadata } from "../../db/schema/org-metadata";
import { grantOrgCredits } from "../org/org-service";
import { handleAutoRechargeInvoicePaid } from "./auto-recharge-service";
import { logger } from "../logger";

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
  items: { data: Array<{ price: { id: string } }> };
}

/** Fields read by {@link handleSubscriptionDeleted}. */
interface SubscriptionDeletedInput {
  id: string;
}

const TIER_MONTHLY_CREDITS: Record<OrgTier, number> = {
  free: 0,
  pro: 20_000,
  max: 80_000,
};

function tierFromPriceId(priceId: string): OrgTier {
  const e = env();
  if (priceId === e.ZERO_PRO_PLAN_PRICE_ID) return "pro";
  if (priceId === e.ZERO_MAX_PLAN_PRICE_ID) return "max";
  throw new Error(`Unknown Stripe price ID: ${priceId}`);
}

/**
 * Get or create a Stripe customer for an org.
 * Returns the Stripe customer ID.
 */
async function getOrCreateStripeCustomer(
  orgId: string,
  orgSlug: string,
): Promise<string> {
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
    metadata: { orgId, orgSlug },
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
  orgSlug: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId, orgSlug);
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
    log.debug("invoice.paid without subscription — skipping", {
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
    log.debug("no credits to grant for tier", { tier, invoiceId: invoice.id });
    return;
  }

  // Grant credits and mark invoice as processed in a transaction
  await db.transaction(async (tx) => {
    await grantOrgCredits(tx, org.orgId, credits);
    await tx
      .update(orgMetadata)
      .set({
        lastProcessedInvoiceId: invoice.id,
        updatedAt: new Date(),
      })
      .where(eq(orgMetadata.orgId, org.orgId));
  });

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
      updatedAt: new Date(),
    })
    .where(eq(orgMetadata.stripeSubscriptionId, subscription.id));

  log.info("subscription deleted — downgraded to free", {
    subscriptionId: subscription.id,
  });
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
 * Get billing status for an org.
 */
export async function getBillingStatus(orgId: string): Promise<{
  tier: string;
  credits: number;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  hasSubscription: boolean;
  autoRecharge: {
    enabled: boolean;
    threshold: number | null;
    amount: number | null;
  };
}> {
  const db = globalThis.services.db;
  const [org] = await db
    .select({
      tier: orgMetadata.tier,
      credits: orgMetadata.credits,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
      autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
      autoRechargeAmount: orgMetadata.autoRechargeAmount,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  return {
    tier: org?.tier ?? "free",
    credits: org?.credits ?? 0,
    subscriptionStatus: org?.subscriptionStatus ?? null,
    currentPeriodEnd: org?.currentPeriodEnd ?? null,
    hasSubscription: !!org?.stripeSubscriptionId,
    autoRecharge: {
      enabled: org?.autoRechargeEnabled ?? false,
      threshold: org?.autoRechargeThreshold ?? null,
      amount: org?.autoRechargeAmount ?? null,
    },
  };
}
