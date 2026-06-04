import type { Stripe } from "stripe";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { getCampaign } from "./one-time-products";
import {
  checkoutTierConflictMessage,
  checkoutWouldReplaceWithSameOrLowerTier,
  type SubscriptionCheckoutTier,
  tierFromPriceId,
} from "./zero-billing-checkout.service";

const L = logger("WebhookStripe");

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface CheckoutSessionInput {
  readonly id: string;
  readonly subscription: string | { readonly id: string } | null;
  readonly customer: string | { readonly id: string } | null;
  readonly metadata: Record<string, string> | null;
  readonly amount_subtotal?: number | null;
  readonly amount_total?: number | null;
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
  readonly customer?: string | { readonly id: string } | null;
  readonly status: string;
  readonly trial_end?: number | null;
  readonly cancel_at?: number | null;
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

interface SubscriptionPreviousAttributes {
  readonly trial_end?: number | null;
}

interface CheckoutSubscriptionContext {
  readonly customerId: string;
  readonly subscriptionId: string;
}

interface InvoicePaidOrg {
  readonly orgId: string;
  readonly lastProcessedInvoiceId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly tier: string;
}

type LockedInvoicePaidOrg = InvoicePaidOrg;

interface SubscriptionInvoiceDetails {
  readonly subscription: SubscriptionInput;
  readonly tier: SubscriptionCheckoutTier;
  readonly credits: number;
  readonly periodEndDate: Date;
  readonly expiresAt: Date;
}

function subscriptionPeriodEnd(subscription: SubscriptionInput): Date | null {
  const periodEndUnix = subscription.items.data[0]?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function subscriptionCancelAt(subscription: SubscriptionInput): Date | null {
  return typeof subscription.cancel_at === "number"
    ? new Date(subscription.cancel_at * 1000)
    : null;
}

function subscriptionWillCancel(subscription: SubscriptionInput): boolean {
  return (
    subscription.cancel_at_period_end ||
    subscriptionCancelAt(subscription) !== null
  );
}

function subscriptionScheduledEnd(
  subscription: SubscriptionInput,
): Date | null {
  return (
    subscriptionCancelAt(subscription) ?? subscriptionPeriodEnd(subscription)
  );
}

function customerIdFromSubscription(
  subscription: SubscriptionInput,
): string | null {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : (subscription.customer?.id ?? null);
}

function subscriptionTrialEnd(subscription: SubscriptionInput): Date | null {
  return typeof subscription.trial_end === "number"
    ? new Date(subscription.trial_end * 1000)
    : null;
}

function requiredSubscriptionTrialEnd(subscription: SubscriptionInput): Date {
  const trialEnd = subscriptionTrialEnd(subscription);
  if (!trialEnd) {
    throw new Error(
      `trialing subscription has no trial_end (subscriptionId=${subscription.id})`,
    );
  }
  return trialEnd;
}

function monthlyCreditsForTier(tier: OrgTier): number {
  switch (tier) {
    case "free": {
      return 0;
    }
    case "pro-suspend": {
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

function subscriptionCreditExpiresAt(
  subscription: SubscriptionInput,
  periodEndDate: Date,
): Date {
  if (subscription.status === "trialing") {
    return requiredSubscriptionTrialEnd(subscription);
  }

  const expiresAt = new Date(periodEndDate);
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  return expiresAt;
}

const CREDITS_PER_DOLLAR = 1000;

function creditPurchaseAmount(session: CheckoutSessionInput): number {
  const metadata = session.metadata ?? {};
  if (metadata.creditsAmountMode === "amount_subtotal") {
    const amountSubtotal = session.amount_subtotal ?? session.amount_total;
    if (amountSubtotal === undefined || amountSubtotal === null) {
      return Number.NaN;
    }
    return Math.floor((amountSubtotal * CREDITS_PER_DOLLAR) / 100);
  }
  if (metadata.creditsAmountMode === "amount_total") {
    const amountTotal = session.amount_total;
    if (amountTotal === undefined || amountTotal === null) {
      return Number.NaN;
    }
    return Math.floor((amountTotal * CREDITS_PER_DOLLAR) / 100);
  }
  return Number(metadata.creditsAmount);
}

function autoRechargeNeverExpiresAt(): Date {
  return new Date("2999-12-31T00:00:00Z");
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

async function lockInvoicePaidOrg(
  tx: WriteTx,
  orgId: string,
): Promise<LockedInvoicePaidOrg | null> {
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

async function existingTrialPlanCredits(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly credits: number;
  },
): Promise<boolean> {
  const rows = await tx
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, args.orgId),
        eq(creditExpiresRecord.source, "subscription_renewal"),
        eq(creditExpiresRecord.amount, args.credits),
      ),
    )
    .for("update");

  return rows.length > 0;
}

async function refreshTrialPlanCredits(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly credits: number;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await tx
    .update(creditExpiresRecord)
    .set({ expiresAt: args.expiresAt })
    .where(
      and(
        eq(creditExpiresRecord.orgId, args.orgId),
        eq(creditExpiresRecord.source, "subscription_renewal"),
        eq(creditExpiresRecord.amount, args.credits),
        gt(creditExpiresRecord.remaining, 0),
      ),
    );
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
  const creditsAmount = creditPurchaseAmount(session);

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

function checkoutSubscriptionContext(
  session: CheckoutSessionInput,
): CheckoutSubscriptionContext | null {
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
  if (!subscriptionId) {
    L.warn("checkout.session.completed without subscription ID", {
      sessionId: session.id,
    });
    return null;
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  if (!customerId) {
    L.warn("checkout.session.completed without customer ID", {
      sessionId: session.id,
    });
    return null;
  }

  return { customerId, subscriptionId };
}

async function shouldSkipSubscriptionBinding(
  db: Db,
  args: {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly tier: SubscriptionCheckoutTier;
  },
): Promise<boolean> {
  const [existing] = await db
    .select({
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, args.customerId))
    .limit(1);

  if (existing?.stripeSubscriptionId === args.subscriptionId) {
    L.debug("subscription binding already processed", {
      subscriptionId: args.subscriptionId,
    });
    return true;
  }
  if (
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: existing?.tier,
      targetTier: args.tier,
    })
  ) {
    L.warn("subscription binding rejected tier replacement", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
      currentTier: existing?.tier ?? null,
      targetTier: args.tier,
      reason: checkoutTierConflictMessage({
        currentTier: existing?.tier,
        targetTier: args.tier,
      }),
    });
    return true;
  }

  return false;
}

async function orgHasStripeCustomer(
  db: Db,
  customerId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, customerId))
    .limit(1);

  return Boolean(existing);
}

async function bindStripeCustomerFromMetadata(
  db: Db,
  args: {
    readonly customerId: string;
    readonly subscriptionId: string;
  },
): Promise<boolean> {
  if (await orgHasStripeCustomer(db, args.customerId)) {
    return true;
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(args.customerId);
  if ("deleted" in customer && customer.deleted) {
    L.warn("stripe customer was deleted before org binding", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
    });
    return false;
  }

  const orgId = customer.metadata.orgId;
  if (!orgId) {
    L.warn("stripe customer has no org metadata", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
    });
    return false;
  }

  const rows = await db
    .update(orgMetadata)
    .set({ stripeCustomerId: args.customerId, updatedAt: nowDate() })
    .where(
      and(eq(orgMetadata.orgId, orgId), isNull(orgMetadata.stripeCustomerId)),
    )
    .returning({ orgId: orgMetadata.orgId });

  if (rows.length > 0) {
    return true;
  }

  const [org] = await db
    .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  L.warn("stripe customer metadata could not bind org", {
    customerId: args.customerId,
    subscriptionId: args.subscriptionId,
    orgId,
    existingStripeCustomerId: org?.stripeCustomerId ?? null,
  });
  return false;
}

async function invoicePaidOrgForCustomer(
  db: Db,
  customerId: string,
): Promise<InvoicePaidOrg | null> {
  const [org] = await db
    .select({
      orgId: orgMetadata.orgId,
      lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, customerId))
    .limit(1);

  return org ?? null;
}

async function invoicePaidOrgForCustomerOrMetadata(
  db: Db,
  args: {
    readonly customerId: string;
    readonly subscriptionId: string;
  },
): Promise<InvoicePaidOrg | null> {
  const org = await invoicePaidOrgForCustomer(db, args.customerId);
  if (org) {
    return org;
  }

  const bound = await bindStripeCustomerFromMetadata(db, args);
  return bound ? await invoicePaidOrgForCustomer(db, args.customerId) : null;
}

async function bindSubscriptionToCustomerOrg(
  db: Db,
  args: {
    readonly customerId: string;
    readonly subscription: SubscriptionInput;
    readonly source:
      | "checkout.session.completed"
      | "customer.subscription.created";
  },
): Promise<void> {
  if (
    args.source === "customer.subscription.created" &&
    !(await bindStripeCustomerFromMetadata(db, {
      customerId: args.customerId,
      subscriptionId: args.subscription.id,
    }))
  ) {
    return;
  }

  const priceId = args.subscription.items.data[0]?.price?.id;
  if (!priceId) {
    L.warn("subscription has no price ID", {
      subscriptionId: args.subscription.id,
      source: args.source,
    });
  } else if (
    await shouldSkipSubscriptionBinding(db, {
      customerId: args.customerId,
      subscriptionId: args.subscription.id,
      tier: tierFromPriceId(priceId),
    })
  ) {
    return;
  }

  const rows = await db
    .update(orgMetadata)
    .set({
      stripeSubscriptionId: args.subscription.id,
      subscriptionStatus: args.subscription.status,
      cancelAtPeriodEnd: subscriptionWillCancel(args.subscription),
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.stripeCustomerId, args.customerId))
    .returning({ orgId: orgMetadata.orgId });

  if (rows.length === 0) {
    L.warn("subscription customer has no matching org", {
      customerId: args.customerId,
      subscriptionId: args.subscription.id,
      source: args.source,
    });
  }
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

function subscriptionIdFromInvoice(invoice: InvoiceInput): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  return typeof subscription === "string"
    ? subscription
    : (subscription?.id ?? null);
}

function customerIdFromInvoice(invoice: InvoiceInput): string | null {
  return typeof invoice.customer === "string"
    ? invoice.customer
    : (invoice.customer?.id ?? null);
}

function subscriptionPeriodEndFromInvoice(
  invoice: InvoiceInput,
  orgId: string,
): Date {
  const subscriptionLine = invoice.lines.data.find((line) => {
    return line.parent?.type === "subscription_item_details";
  });
  const periodEndUnix = subscriptionLine?.period.end;
  if (!periodEndUnix) {
    throw new Error(
      `invoice.paid has no subscription line item with period.end (invoiceId=${invoice.id}, orgId=${orgId})`,
    );
  }
  return new Date(periodEndUnix * 1000);
}

async function subscriptionInvoiceDetails(
  invoice: InvoiceInput,
  args: {
    readonly subscriptionId: string;
    readonly orgId: string;
  },
): Promise<SubscriptionInvoiceDetails | null> {
  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(args.subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) {
    L.warn("subscription has no price ID for credit grant", {
      subscriptionId: args.subscriptionId,
    });
    return null;
  }

  const tier = tierFromPriceId(priceId);
  const credits = monthlyCreditsForTier(tier);
  if (credits <= 0) {
    L.warn("no credits to grant for tier", {
      tier,
      invoiceId: invoice.id,
      orgId: args.orgId,
    });
    return null;
  }

  const periodEndDate = subscriptionPeriodEndFromInvoice(invoice, args.orgId);
  return {
    subscription,
    tier,
    credits,
    periodEndDate,
    expiresAt: subscriptionCreditExpiresAt(subscription, periodEndDate),
  };
}

async function updateSubscriptionInvoiceMetadata(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly invoiceId: string;
    readonly subscriptionId: string;
    readonly details: SubscriptionInvoiceDetails;
  },
): Promise<void> {
  await tx
    .update(orgMetadata)
    .set({
      tier: args.details.tier,
      stripeSubscriptionId: args.subscriptionId,
      subscriptionStatus: args.details.subscription.status,
      cancelAtPeriodEnd: subscriptionWillCancel(args.details.subscription),
      onboardingPaymentPending: false,
      lastProcessedInvoiceId: args.invoiceId,
      currentPeriodEnd: args.details.periodEndDate,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, args.orgId));
}

async function processSubscriptionInvoicePaid(
  tx: WriteTx,
  args: {
    readonly invoice: InvoiceInput;
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly orgId: string;
    readonly details: SubscriptionInvoiceDetails;
  },
): Promise<void> {
  const lockedOrg = await lockInvoicePaidOrg(tx, args.orgId);
  if (!lockedOrg) {
    return;
  }

  if (lockedOrg.lastProcessedInvoiceId === args.invoice.id) {
    L.debug("invoice.paid already processed by concurrent delivery", {
      invoiceId: args.invoice.id,
      orgId: args.orgId,
    });
    return;
  }

  if (
    invoiceWouldReplaceWithSameOrLowerTier({
      currentSubscriptionId: lockedOrg.stripeSubscriptionId,
      subscriptionId: args.subscriptionId,
      currentTier: lockedOrg.tier,
      targetTier: args.details.tier,
    })
  ) {
    L.warn("invoice.paid rejected tier replacement", {
      customerId: args.customerId,
      invoiceId: args.invoice.id,
      subscriptionId: args.subscriptionId,
      currentSubscriptionId: lockedOrg.stripeSubscriptionId,
      currentTier: lockedOrg.tier,
      targetTier: args.details.tier,
      reason: checkoutTierConflictMessage({
        currentTier: lockedOrg.tier,
        targetTier: args.details.tier,
      }),
    });
    return;
  }

  const trialingExistingSubscription =
    args.details.subscription.status === "trialing" &&
    lockedOrg.stripeSubscriptionId === args.subscriptionId &&
    lockedOrg.tier === args.details.tier &&
    (await existingTrialPlanCredits(tx, {
      orgId: args.orgId,
      credits: args.details.credits,
    }));

  if (trialingExistingSubscription) {
    await refreshTrialPlanCredits(tx, {
      orgId: args.orgId,
      credits: args.details.credits,
      expiresAt: args.details.expiresAt,
    });
    await updateSubscriptionInvoiceMetadata(tx, {
      orgId: args.orgId,
      invoiceId: args.invoice.id,
      subscriptionId: args.subscriptionId,
      details: args.details,
    });
    return;
  }

  await expireCredits(tx, args.orgId);

  const inserted = await createExpiresRecord(tx, args.orgId, {
    source: "subscription_renewal",
    stripeInvoiceId: args.invoice.id,
    amount: args.details.credits,
    expiresAt: args.details.expiresAt,
  });
  if (!inserted) {
    L.debug("invoice.paid already processed by concurrent delivery", {
      invoiceId: args.invoice.id,
      orgId: args.orgId,
    });
    return;
  }

  await grantOrgCredits(tx, args.orgId, args.details.credits);
  await updateSubscriptionInvoiceMetadata(tx, {
    orgId: args.orgId,
    invoiceId: args.invoice.id,
    subscriptionId: args.subscriptionId,
    details: args.details,
  });
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

  const checkoutContext = checkoutSubscriptionContext(session);
  if (!checkoutContext) {
    return;
  }
  const { customerId, subscriptionId } = checkoutContext;

  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await bindSubscriptionToCustomerOrg(db, {
    customerId,
    subscription,
    source: "checkout.session.completed",
  });
}

async function handleSubscriptionCreated(
  db: Db,
  subscription: SubscriptionInput,
): Promise<void> {
  const customerId = customerIdFromSubscription(subscription);
  if (!customerId) {
    L.warn("customer.subscription.created without customer ID", {
      subscriptionId: subscription.id,
    });
    return;
  }

  await bindSubscriptionToCustomerOrg(db, {
    customerId,
    subscription,
    source: "customer.subscription.created",
  });
}

async function handleInvoicePaid(db: Db, invoice: InvoiceInput): Promise<void> {
  const handled = await handleAutoRechargeInvoicePaid(db, invoice);
  if (handled) {
    return;
  }

  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) {
    L.warn("invoice.paid without subscription; skipping", {
      invoiceId: invoice.id,
    });
    return;
  }

  const customerId = customerIdFromInvoice(invoice);
  if (!customerId) {
    L.warn("invoice.paid without customer ID", { invoiceId: invoice.id });
    return;
  }

  const org = await invoicePaidOrgForCustomerOrMetadata(db, {
    customerId,
    subscriptionId,
  });
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

  const details = await subscriptionInvoiceDetails(invoice, {
    subscriptionId,
    orgId: org.orgId,
  });
  if (!details) {
    return;
  }

  await db.transaction(async (tx) => {
    await processSubscriptionInvoicePaid(tx, {
      invoice,
      customerId,
      subscriptionId,
      orgId: org.orgId,
      details,
    });
  });
}

async function handleSubscriptionUpdated(
  db: Db,
  subscription: SubscriptionInput,
  previousAttributes: SubscriptionPreviousAttributes | undefined,
): Promise<void> {
  const periodEnd = subscriptionWillCancel(subscription)
    ? subscriptionScheduledEnd(subscription)
    : null;
  const trialEnd = subscriptionTrialEnd(subscription);
  const previousTrialEnd =
    typeof previousAttributes?.trial_end === "number"
      ? new Date(previousAttributes.trial_end * 1000)
      : null;
  const trialShortened =
    subscription.status === "trialing" &&
    trialEnd !== null &&
    previousTrialEnd !== null &&
    trialEnd < previousTrialEnd;

  await db.transaction(async (tx) => {
    const rows = await tx
      .update(orgMetadata)
      .set({
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscriptionWillCancel(subscription),
        updatedAt: nowDate(),
        ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
        ...(trialShortened ? { currentPeriodEnd: trialEnd } : {}),
      })
      .where(eq(orgMetadata.stripeSubscriptionId, subscription.id))
      .returning({ orgId: orgMetadata.orgId });

    if (!trialShortened) {
      return;
    }

    for (const row of rows) {
      await tx
        .update(creditExpiresRecord)
        .set({ expiresAt: trialEnd })
        .where(
          and(
            eq(creditExpiresRecord.orgId, row.orgId),
            eq(creditExpiresRecord.source, "subscription_renewal"),
            gt(creditExpiresRecord.expiresAt, trialEnd),
            gt(creditExpiresRecord.remaining, 0),
          ),
        );
    }
  });
}

async function handleSubscriptionDeleted(
  db: Db,
  subscription: SubscriptionDeletedInput,
): Promise<void> {
  await db
    .update(orgMetadata)
    .set({
      tier: "pro-suspend",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
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
      case "customer.subscription.created": {
        await handleSubscriptionCreated(db, event.data.object);
        signal.throwIfAborted();
        break;
      }
      case "customer.subscription.updated": {
        await handleSubscriptionUpdated(
          db,
          event.data.object,
          event.data.previous_attributes,
        );
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
