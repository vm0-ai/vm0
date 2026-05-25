import type { Stripe } from "stripe";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, gt, lte, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { getCampaign } from "./one-time-products";

const L = logger("WebhookStripe");

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface CheckoutSessionInput {
  readonly id: string;
  readonly subscription: string | { readonly id: string } | null;
  readonly customer: string | { readonly id: string } | null;
  readonly metadata: Record<string, string> | null;
  readonly payment_status?: string | null;
}

interface InvoiceInput {
  readonly id: string;
  readonly customer: string | { readonly id: string } | null;
  readonly metadata: Record<string, string> | null;
  readonly lines: {
    readonly data: readonly {
      readonly period: { readonly end: number };
      readonly parent: {
        readonly type: "subscription_item_details" | "invoice_item_details";
      } | null;
    }[];
  };
  readonly parent: {
    readonly subscription_details: {
      readonly subscription: string | { readonly id: string };
    } | null;
  } | null;
}

interface SubscriptionInput {
  readonly id: string;
  readonly status: string;
  readonly cancel_at_period_end: boolean;
  readonly items: {
    readonly data: readonly {
      readonly price: { readonly id: string };
      readonly current_period_end?: number | null;
    }[];
  };
}

interface SubscriptionDeletedInput {
  readonly id: string;
}

function subscriptionPeriodEnd(subscription: SubscriptionInput): Date | null {
  const periodEndUnix = subscription.items.data[0]?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function subscriptionCanRefreshPaidThrough(
  subscription: SubscriptionInput,
): boolean {
  return subscription.status === "active" || subscription.status === "trialing";
}

function monthlyCreditsForTier(tier: OrgTier): number {
  switch (tier) {
    case "free": {
      return 0;
    }
    case "pro": {
      return 20_000;
    }
    case "team": {
      return 120_000;
    }
  }
}

function autoRechargeNeverExpiresAt(): Date {
  return new Date("2999-12-31T00:00:00Z");
}

function tierFromPriceId(priceId: string): OrgTier {
  const priceMap = env("ZERO_PRICE");
  if (priceMap) {
    for (const [tier, ids] of Object.entries(priceMap)) {
      if (ids.includes(priceId)) {
        return tier as OrgTier;
      }
    }
  }
  throw new Error(`Unknown Stripe price ID: ${priceId}`);
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

async function createExpiresRecord(
  tx: WriteTx,
  orgId: string,
  params: {
    readonly source: string;
    readonly stripeInvoiceId: string;
    readonly amount: number;
    readonly expiresAt: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: params.source,
      stripeInvoiceId: params.stripeInvoiceId,
      amount: params.amount,
      remaining: params.amount,
      expiresAt: params.expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });

  return rows.length > 0;
}

async function expireCredits(tx: WriteTx, orgId: string): Promise<number> {
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

  if (expired.length === 0) {
    return 0;
  }

  const totalExpired = expired.reduce((sum, record) => {
    return sum + record.remaining;
  }, 0);

  for (const record of expired) {
    await tx
      .update(creditExpiresRecord)
      .set({ remaining: 0 })
      .where(eq(creditExpiresRecord.id, record.id));
  }

  if (totalExpired > 0) {
    await tx
      .update(orgMetadata)
      .set({
        credits: sql`GREATEST(${orgMetadata.credits} - ${totalExpired}, 0)`,
        updatedAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, orgId));
  }

  L.debug("expired credits settled", { orgId, totalExpired });
  return totalExpired;
}

async function handleAutoRechargeInvoicePaid(
  db: Db,
  invoice: Pick<InvoiceInput, "id" | "metadata">,
): Promise<boolean> {
  const metadata = invoice.metadata;
  if (!metadata || metadata.type !== "auto_recharge") {
    return false;
  }

  const orgId = metadata.orgId;
  const creditsAmount = Number(metadata.creditsAmount);
  if (!orgId || !creditsAmount || Number.isNaN(creditsAmount)) {
    L.warn("Auto-recharge invoice has invalid metadata", {
      invoiceId: invoice.id,
      metadata,
    });
    return false;
  }

  const granted = await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, orgId, {
      source: "auto_recharge",
      stripeInvoiceId: invoice.id,
      amount: creditsAmount,
      expiresAt: autoRechargeNeverExpiresAt(),
    });

    if (!inserted) {
      L.debug("Auto-recharge invoice already processed", {
        orgId,
        invoiceId: invoice.id,
      });
      return false;
    }

    await grantOrgCredits(tx, orgId, creditsAmount);
    await tx
      .update(orgMetadata)
      .set({ autoRechargePendingAt: null, updatedAt: nowDate() })
      .where(eq(orgMetadata.orgId, orgId));
    return true;
  });

  if (granted) {
    L.debug("Auto-recharge credits granted", {
      orgId,
      creditsAmount,
      invoiceId: invoice.id,
    });
  }

  return true;
}

async function handleOneTimePurchaseCompleted(
  db: Db,
  session: CheckoutSessionInput,
): Promise<void> {
  const metadata = session.metadata ?? {};
  const orgId = metadata.orgId;
  const campaignKey = metadata.campaignKey;

  if (!orgId || !campaignKey) {
    L.warn("one_time_purchase missing metadata", {
      sessionId: session.id,
      hasOrgId: Boolean(orgId),
      hasCampaignKey: Boolean(campaignKey),
    });
    return;
  }

  const campaign = getCampaign(campaignKey);
  if (!campaign) {
    L.warn("one_time_purchase unknown campaign; skipping", {
      sessionId: session.id,
      campaignKey,
    });
    return;
  }

  const expiresAt = new Date(
    now() + campaign.expiresDays * 24 * 60 * 60 * 1000,
  );

  await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, orgId, {
      source: campaign.source,
      stripeInvoiceId: session.id,
      amount: campaign.credits,
      expiresAt,
    });

    if (!inserted) {
      L.debug("one_time_purchase already processed", {
        sessionId: session.id,
        orgId,
      });
      return;
    }

    await grantOrgCredits(tx, orgId, campaign.credits);
  });
}

async function handleCreditPurchaseCompleted(
  db: Db,
  session: CheckoutSessionInput,
): Promise<void> {
  const metadata = session.metadata ?? {};
  const orgId = metadata.orgId;
  const creditsAmount = Number(metadata.creditsAmount);

  if (!orgId || !creditsAmount || Number.isNaN(creditsAmount)) {
    L.warn("credit_purchase missing metadata", {
      sessionId: session.id,
      hasOrgId: Boolean(orgId),
      creditsAmount: metadata.creditsAmount ?? null,
    });
    return;
  }

  await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, orgId, {
      source: "auto_recharge",
      stripeInvoiceId: session.id,
      amount: creditsAmount,
      expiresAt: autoRechargeNeverExpiresAt(),
    });

    if (!inserted) {
      L.debug("credit_purchase already processed", {
        sessionId: session.id,
        orgId,
      });
      return;
    }

    await grantOrgCredits(tx, orgId, creditsAmount);
  });
}

async function handlePaidCheckoutPurpose(
  db: Db,
  session: CheckoutSessionInput,
  purpose: "credit_purchase" | "one_time_purchase",
): Promise<boolean> {
  if (session.metadata?.purpose !== purpose) {
    return false;
  }

  if (session.payment_status !== "paid") {
    L.debug(`${purpose} checkout completed before payment settled`, {
      sessionId: session.id,
      paymentStatus: session.payment_status ?? null,
    });
    return true;
  }

  if (purpose === "credit_purchase") {
    await handleCreditPurchaseCompleted(db, session);
  } else {
    await handleOneTimePurchaseCompleted(db, session);
  }

  return true;
}

async function handleCheckoutCompleted(
  db: Db,
  session: CheckoutSessionInput,
): Promise<void> {
  if (await handlePaidCheckoutPurpose(db, session, "credit_purchase")) {
    return;
  }

  if (await handlePaidCheckoutPurpose(db, session, "one_time_purchase")) {
    return;
  }

  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
  if (!subscriptionId) {
    L.warn("checkout.session.completed without subscription ID", {
      sessionId: session.id,
    });
    return;
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  if (!customerId) {
    L.warn("checkout.session.completed without customer ID", {
      sessionId: session.id,
    });
    return;
  }

  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) {
    L.warn("subscription has no price ID", { subscriptionId });
    return;
  }

  const tier = tierFromPriceId(priceId);
  const [existing] = await db
    .select({ stripeSubscriptionId: orgMetadata.stripeSubscriptionId })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, customerId))
    .limit(1);

  if (existing?.stripeSubscriptionId === subscriptionId) {
    L.debug("checkout.session.completed already processed", { subscriptionId });
    return;
  }

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
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.stripeCustomerId, customerId));
}

async function handleInvoicePaid(db: Db, invoice: InvoiceInput): Promise<void> {
  const handled = await handleAutoRechargeInvoicePaid(db, invoice);
  if (handled) {
    return;
  }

  const subscription = invoice.parent?.subscription_details?.subscription;
  const subscriptionId =
    typeof subscription === "string" ? subscription : subscription?.id;
  if (!subscriptionId) {
    L.warn("invoice.paid without subscription; skipping", {
      invoiceId: invoice.id,
    });
    return;
  }

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) {
    L.warn("invoice.paid without customer ID", { invoiceId: invoice.id });
    return;
  }

  const [org] = await db
    .select({
      orgId: orgMetadata.orgId,
      lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, customerId))
    .limit(1);

  if (!org) {
    L.warn("invoice.paid for unknown customer", {
      customerId,
      invoiceId: invoice.id,
    });
    return;
  }

  if (org.lastProcessedInvoiceId === invoice.id) {
    L.debug("invoice.paid already processed", {
      invoiceId: invoice.id,
      orgId: org.orgId,
    });
    return;
  }

  const stripe = getStripeClient();
  const subscriptionRecord =
    await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscriptionRecord.items.data[0]?.price?.id;
  if (!priceId) {
    L.warn("subscription has no price ID for credit grant", {
      subscriptionId,
    });
    return;
  }

  const tier = tierFromPriceId(priceId);
  const credits = monthlyCreditsForTier(tier);
  if (credits <= 0) {
    L.warn("no credits to grant for tier", {
      tier,
      invoiceId: invoice.id,
      orgId: org.orgId,
    });
    return;
  }

  const subscriptionLine = invoice.lines.data.find((line) => {
    return line.parent?.type === "subscription_item_details";
  });
  const periodEndUnix = subscriptionLine?.period.end;
  if (!periodEndUnix) {
    throw new Error(
      `invoice.paid has no subscription line item with period.end (invoiceId=${invoice.id}, orgId=${org.orgId})`,
    );
  }
  const periodEndDate = new Date(periodEndUnix * 1000);
  const expiresAt = new Date(periodEndDate);
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  await db.transaction(async (tx) => {
    await expireCredits(tx, org.orgId);

    const inserted = await createExpiresRecord(tx, org.orgId, {
      source: "subscription_renewal",
      stripeInvoiceId: invoice.id,
      amount: credits,
      expiresAt,
    });
    if (!inserted) {
      L.debug("invoice.paid already processed by concurrent delivery", {
        invoiceId: invoice.id,
        orgId: org.orgId,
      });
      return;
    }

    await grantOrgCredits(tx, org.orgId, credits);
    await tx
      .update(orgMetadata)
      .set({
        lastProcessedInvoiceId: invoice.id,
        currentPeriodEnd: periodEndDate,
        updatedAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, org.orgId));
  });
}

async function handleSubscriptionUpdated(
  db: Db,
  subscription: SubscriptionInput,
): Promise<void> {
  const priceId = subscription.items.data[0]?.price?.id;
  const canSyncPaidEntitlement =
    subscriptionCanRefreshPaidThrough(subscription);
  const tier: OrgTier | undefined =
    canSyncPaidEntitlement && priceId ? tierFromPriceId(priceId) : undefined;
  const periodEnd = canSyncPaidEntitlement
    ? subscriptionPeriodEnd(subscription)
    : null;

  await db
    .update(orgMetadata)
    .set({
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      updatedAt: nowDate(),
      ...(tier ? { tier } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    })
    .where(eq(orgMetadata.stripeSubscriptionId, subscription.id));
}

async function handleSubscriptionDeleted(
  db: Db,
  subscription: SubscriptionDeletedInput,
): Promise<void> {
  await db
    .update(orgMetadata)
    .set({
      tier: "free",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: false,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.stripeSubscriptionId, subscription.id));
}

export const handleStripeWebhookEvent$ = command(
  async ({ set }, event: Stripe.Event, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    L.debug("stripe webhook received", { type: event.type, id: event.id });

    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(db, event.data.object);
        signal.throwIfAborted();
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        await handleCheckoutCompleted(db, event.data.object);
        signal.throwIfAborted();
        break;
      }
      case "invoice.paid": {
        await handleInvoicePaid(db, event.data.object);
        signal.throwIfAborted();
        break;
      }
      case "customer.subscription.updated": {
        await handleSubscriptionUpdated(db, event.data.object);
        signal.throwIfAborted();
        break;
      }
      case "customer.subscription.deleted": {
        await handleSubscriptionDeleted(db, event.data.object);
        signal.throwIfAborted();
        break;
      }
      default: {
        L.debug("ignoring unhandled Stripe event", { type: event.type });
      }
    }

    signal.throwIfAborted();
  },
);
