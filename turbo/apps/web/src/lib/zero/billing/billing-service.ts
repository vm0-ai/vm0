import { eq, sql } from "drizzle-orm";
import type { OrgTier } from "@vm0/core/contracts/orgs";
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
  getUnsettledExpiredAmount,
  getCreditBreakdownRecords,
} from "../credit/credit-expires-service";
import { getCampaign } from "./one-time-products";
import { ensureStarterCreditGrant } from "../credit/starter-grant-service";
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
  metadata: Record<string, string> | null;
  payment_status?: string | null;
}

/** Fields read by {@link handleInvoicePaid}. */
interface InvoiceInput {
  id: string;
  customer: string | { id: string } | null;
  metadata: Record<string, string> | null;
  lines: {
    data: Array<{
      period: { end: number };
      parent: {
        type: "subscription_item_details" | "invoice_item_details";
      } | null;
    }>;
  };
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
  return db.transaction(async (tx) => {
    // Serialize customer materialization per org so concurrent checkout / redeem
    // requests cannot mint multiple Stripe customers and orphan webhook events.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('stripe_customer_' || ${orgId}))`,
    );

    const [row] = await tx
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

    // Guarantee the starter grant at first org_metadata materialisation — a
    // free user may skip onboarding and first hit billing (pricing → upgrade).
    await ensureStarterCreditGrant(tx, orgId);
    await tx
      .insert(orgMetadata)
      .values({ orgId, stripeCustomerId: customer.id })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { stripeCustomerId: customer.id, updatedAt: new Date() },
      });

    return customer.id;
  });
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
 * Does NOT grant credits for subscriptions (single code path via invoice.paid).
 *
 * One-time purchases (`metadata.purpose === "one_time_purchase"`) are
 * dispatched to {@link handleOneTimePurchaseCompleted}, which grants credits
 * sourced from the server-side campaign registry.
 */
export async function handleCheckoutCompleted(
  session: CheckoutSessionInput,
): Promise<void> {
  if (session.metadata?.purpose === "one_time_purchase") {
    if (session.payment_status !== "paid") {
      log.info("one_time_purchase checkout completed before payment settled", {
        sessionId: session.id,
        paymentStatus: session.payment_status ?? null,
      });
      return;
    }
    await handleOneTimePurchaseCompleted(session);
    return;
  }

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

  // In Stripe v2025 API, current_period_end was removed from the top-level
  // Subscription object. The replacement is subscription.items.data[i].
  // current_period_end — the end time of the subscription item's current
  // billing period. (Do NOT read invoice.period_end — that field is the
  // accrual period for the invoice, not the subscription period, and for
  // renewal invoices collapses to the invoice creation moment.)
  const itemPeriodEnd = subscription.items.data[0]?.current_period_end;
  const periodEnd = itemPeriodEnd ? new Date(itemPeriodEnd * 1000) : undefined;

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
 * Grant credits for a completed one-time purchase. The `credits`, `expiresDays`
 * and `source` values are looked up via {@link getCampaign} — never read from
 * webhook metadata — so an attacker who forges a session metadata can't
 * inflate the payout. Idempotent via `createExpiresRecord`'s unique index on
 * `(org_id, stripe_invoice_id)`.
 */
async function handleOneTimePurchaseCompleted(
  session: CheckoutSessionInput,
): Promise<void> {
  const metadata = session.metadata ?? {};
  const orgId = metadata.orgId;
  const campaignKey = metadata.campaignKey;

  if (!orgId || !campaignKey) {
    log.warn("one_time_purchase missing metadata", {
      sessionId: session.id,
      hasOrgId: !!orgId,
      hasCampaignKey: !!campaignKey,
    });
    return;
  }

  const campaign = getCampaign(campaignKey);
  if (!campaign) {
    log.warn("one_time_purchase unknown campaign — skipping", {
      sessionId: session.id,
      campaignKey,
    });
    return;
  }

  const expiresAt = new Date(
    Date.now() + campaign.expiresDays * 24 * 60 * 60 * 1000,
  );
  const db = globalThis.services.db;
  await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, orgId, {
      source: campaign.source,
      stripeInvoiceId: session.id,
      amount: campaign.credits,
      expiresAt,
    });
    if (!inserted) {
      log.info("one_time_purchase already processed — skipping", {
        sessionId: session.id,
        orgId,
      });
      return;
    }
    await grantOrgCredits(tx, orgId, campaign.credits);
    log.info("one_time_purchase credits granted", {
      orgId,
      campaignKey,
      credits: campaign.credits,
      sessionId: session.id,
    });
  });
}

// ---------------------------------------------------------------------------
// One-time Checkout Session creation (used by POST /api/zero/billing/redeem/:campaign)
// ---------------------------------------------------------------------------

/**
 * Create a Stripe Checkout session for a one-time campaign redemption.
 *
 * The session carries a fixed metadata shape the webhook relies on to
 * dispatch to {@link handleOneTimePurchaseCompleted}. Callers are responsible
 * for checking that `campaignKey` is whitelisted *before* calling this —
 * see {@link getCampaign}.
 */
export async function createOneTimeCheckoutSession(params: {
  orgId: string;
  campaignKey: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ sessionId: string; url: string }> {
  const campaign = getCampaign(params.campaignKey);
  if (!campaign) {
    throw new Error(`Unknown campaign: ${params.campaignKey}`);
  }

  const customerId = await getOrCreateStripeCustomer(params.orgId);
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{ price: campaign.priceId, quantity: 1 }],
    discounts: [{ coupon: campaign.couponId }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: {
      orgId: params.orgId,
      campaignKey: params.campaignKey,
      purpose: "one_time_purchase",
    },
  });

  if (!session.url) {
    throw new Error("Stripe checkout session did not return a URL");
  }
  return { sessionId: session.id, url: session.url };
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

  // The subscription line item's period.end is the actual subscription
  // billing-cycle end — i.e. the time the customer is paying through.
  // (The top-level invoice.period_end is the "period over which billables
  // accrued" and for a renewal invoice collapses to the invoice creation
  // moment, not the next renewal date — do NOT use it here.)
  const subscriptionLine = invoice.lines.data.find((line) => {
    return line.parent?.type === "subscription_item_details";
  });
  const periodEndUnix = subscriptionLine?.period.end;
  if (!periodEndUnix) {
    throw new Error(
      `invoice.paid has no subscription line item with period.end — cannot create expiry record (invoiceId=${invoice.id}, orgId=${org.orgId})`,
    );
  }
  const periodEndDate = new Date(periodEndUnix * 1000);
  const expiresAt = new Date(periodEndDate);
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  // Grant credits and mark invoice as processed in a transaction.
  //
  // The `lastProcessedInvoiceId` fast path above catches sequential retries
  // (first delivery commits, later retry sees the updated value). It fails
  // open when two deliveries race: both reads see the old value, both pass,
  // and both would grant credits. The durable guard is `createExpiresRecord`
  // — it inserts with ON CONFLICT DO NOTHING on the
  // `(org_id, stripe_invoice_id)` unique index, and a losing concurrent tx
  // blocks until the winner commits then observes the conflict, so only one
  // caller sees `inserted=true`. Gate `grantOrgCredits` on that flag.
  const granted = await db.transaction(async (tx) => {
    // Settle expired credits before granting new ones. Safe to run in the
    // losing tx too: `expireCredits` takes SELECT FOR UPDATE on expired
    // rows, so the loser sees `remaining = 0` once the winner commits and
    // no-ops.
    await expireCredits(tx, org.orgId);

    const inserted = await createExpiresRecord(tx, org.orgId, {
      source: "subscription_renewal",
      stripeInvoiceId: invoice.id,
      amount: credits,
      expiresAt,
    });
    if (!inserted) {
      log.info(
        "invoice.paid already processed — skipping (concurrent delivery)",
        { invoiceId: invoice.id, orgId: org.orgId },
      );
      return false;
    }

    await grantOrgCredits(tx, org.orgId, credits);

    await tx
      .update(orgMetadata)
      .set({
        lastProcessedInvoiceId: invoice.id,
        currentPeriodEnd: periodEndDate,
        updatedAt: new Date(),
      })
      .where(eq(orgMetadata.orgId, org.orgId));

    return true;
  });

  if (!granted) return;

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

type DowngradeResult =
  | { ok: true; effectiveDate: string | null }
  | { ok: false; reason: "no_subscription" }
  | {
      ok: false;
      reason: "invalid_target_tier";
      currentTier: OrgTier;
      targetTier: "free" | "pro";
    };

/**
 * Downgrade a subscription to a lower tier.
 *
 * - Team -> Pro: updates the subscription's price via Stripe API (immediate).
 * - Paid -> Free: cancels the subscription at period end.
 *
 * Expected client-facing validation failures (no active subscription, target
 * tier not lower than current) are returned as `{ ok: false, reason }` so the
 * route layer can map them to 4xx responses. Unexpected failures (Stripe
 * errors, misconfigured price IDs) continue to throw.
 */
export async function downgradeSubscription(
  orgId: string,
  targetTier: "free" | "pro",
): Promise<DowngradeResult> {
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
    return { ok: false, reason: "no_subscription" };
  }

  const currentTier = org.tier as OrgTier;
  if (TIER_RANK[targetTier] >= TIER_RANK[currentTier]) {
    return {
      ok: false,
      reason: "invalid_target_tier",
      currentTier,
      targetTier,
    };
  }

  const stripe = getStripe();

  if (targetTier === "free") {
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
    return { ok: true, effectiveDate };
  }

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
  return { ok: true, effectiveDate: null };
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
    if (threshold >= amount) {
      return {
        ok: false,
        error: "threshold must be less than amount to avoid recharge loops",
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

type CreditBreakdownCategory = "plan" | "free" | "promotional" | "payAsYouGo";

interface CreditBreakdownSegment {
  category: CreditBreakdownCategory;
  label: string;
  credits: number;
  /** Only set on `plan` segments. */
  tier?: "pro" | "team";
}

/**
 * Build the Usage-tab credit breakdown from active expires records.
 *
 * - `subscription_renewal` → "<Tier> plan" under category `plan`, tier derived
 *   from the record's amount so leftover credits from a previous tier (e.g. a
 *   Team user that dropped to Pro) render under their original tier label.
 *   The raw `tier` (`"pro" | "team"`) is also emitted on each plan segment so
 *   UI callers don't have to round-trip through the display label.
 * - `starter_grant` → "Free plan".
 * - `one_time_purchase` → "Promotional".
 * - `auto_recharge` → "Pay as you go" (sentinel record from #10668).
 *
 * Legacy balance not backed by any active record (pre-sentinel top-ups,
 * ledger drift) is surfaced as "Pay as you go" for paid tiers or "Free plan"
 * for free, so the segments always sum to `displayedCredits`. When a non-zero
 * untracked delta is observed we emit a `logger.warn` so ops can track drift.
 */
function buildCreditBreakdown(args: {
  orgId: string;
  tier: string;
  displayedCredits: number;
  records: Array<{ source: string; amount: number; remaining: number }>;
}): CreditBreakdownSegment[] {
  const { orgId, tier, displayedCredits, records } = args;

  // Returns `null` when the amount doesn't match any known tier — caller will
  // skip emitting a plan segment for such a record, avoiding a fabricated tier.
  const planTierFromAmount = (amount: number): "pro" | "team" | null => {
    if (amount === TIER_MONTHLY_CREDITS.team) return "team";
    if (amount === TIER_MONTHLY_CREDITS.pro) return "pro";
    return null;
  };

  const segmentKey = (category: CreditBreakdownCategory, tierKey?: string) => {
    return tierKey ? `${category}:${tierKey}` : category;
  };

  const byKey = new Map<string, CreditBreakdownSegment>();
  const addSegment = (segment: CreditBreakdownSegment) => {
    const key = segmentKey(segment.category, segment.tier);
    const existing = byKey.get(key);
    if (existing) {
      existing.credits += segment.credits;
    } else {
      byKey.set(key, { ...segment });
    }
  };

  let trackedTotal = 0;
  for (const r of records) {
    trackedTotal += r.remaining;
    if (r.source === "subscription_renewal") {
      const planTier = planTierFromAmount(r.amount);
      if (!planTier) {
        log.warn("subscription_renewal amount does not match any tier", {
          orgId,
          amount: r.amount,
          remaining: r.remaining,
        });
        // Fall through: surface the remaining as untracked so the bar still
        // sums to `displayedCredits`.
        trackedTotal -= r.remaining;
        continue;
      }
      const label = planTier === "team" ? "Team plan" : "Pro plan";
      addSegment({
        category: "plan",
        label,
        credits: r.remaining,
        tier: planTier,
      });
    } else if (r.source === "starter_grant") {
      addSegment({
        category: "free",
        label: "Free plan",
        credits: r.remaining,
      });
    } else if (r.source === "one_time_purchase") {
      addSegment({
        category: "promotional",
        label: "Promotional",
        credits: r.remaining,
      });
    } else if (r.source === "auto_recharge") {
      addSegment({
        category: "payAsYouGo",
        label: "Pay as you go",
        credits: r.remaining,
      });
    }
  }

  const untracked = Math.max(displayedCredits - trackedTotal, 0);
  if (untracked > 0) {
    log.warn("credit breakdown has untracked balance", {
      orgId,
      tier,
      displayedCredits,
      trackedTotal,
      untracked,
    });
    if (tier === "free") {
      addSegment({
        category: "free",
        label: "Free plan",
        credits: untracked,
      });
    } else {
      addSegment({
        category: "payAsYouGo",
        label: "Pay as you go",
        credits: untracked,
      });
    }
  }

  const categoryOrder: CreditBreakdownCategory[] = [
    "plan",
    "free",
    "promotional",
    "payAsYouGo",
  ];
  const segments = Array.from(byKey.values());
  segments.sort((a, b) => {
    return (
      categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category)
    );
  });
  return segments;
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
  creditBreakdown: CreditBreakdownSegment[];
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

  const [expirySummary, unsettledExpired, records] = await Promise.all([
    getExpiresRecordsSummary(orgId),
    getUnsettledExpiredAmount(orgId),
    getCreditBreakdownRecords(orgId),
  ]);

  const rawCredits = org?.credits ?? 0;
  const displayedCredits = Math.max(rawCredits - unsettledExpired, 0);
  const tier = org?.tier ?? "free";

  const breakdown = buildCreditBreakdown({
    orgId,
    tier,
    displayedCredits,
    records,
  });

  return {
    tier,
    credits: displayedCredits,
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
    creditBreakdown: breakdown,
  };
}
