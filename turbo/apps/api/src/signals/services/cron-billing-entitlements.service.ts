import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgConcurrencySubscriptions } from "@vm0/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgUsageAllowanceEntitlements } from "@vm0/db/schema/org-usage-allowance";
import { command } from "ccstate";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import {
  CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";
import {
  upsertOrgPlanEntitlement,
  writeOrgMetadataWithPlanEntitlements,
} from "./org-plan-entitlements.service";
import { disableIneligibleWorkflowWebhookAutomationsForOrg } from "./workflow-webhook-automation-entitlement.service";

const L = logger("CronBillingEntitlements");
const PAID_TIERS = ["pro", "team", "custom"] as const;
const STRIPE_SUBSCRIPTION_PRICE_TIERS = ["pro", "team"] as const;
type SubscriptionPriceTier = (typeof STRIPE_SUBSCRIPTION_PRICE_TIERS)[number];

const ENTITLEMENT_PERIOD_REFRESH_STATUSES = ["active", "trialing"] as const;
const PAYMENT_FAILED_SUBSCRIPTION_STATUSES = ["past_due", "unpaid"] as const;
const USAGE_ALLOWANCE_RECONCILE_STATUSES = [
  ...ENTITLEMENT_PERIOD_REFRESH_STATUSES,
  ...PAYMENT_FAILED_SUBSCRIPTION_STATUSES,
] as const;
const PAYMENT_FAILURE_DOWNGRADE_GRACE_MS = 24 * 60 * 60 * 1000;
const ATOM_GRANT_SUBSCRIPTION_STATUS = "atom_grant";
const TERMINAL_USAGE_ALLOWANCE_STATUSES = [
  "canceled",
  "incomplete_expired",
] as const;
const CANCELED_SUBSCRIPTION_TARGET_TIER = "limited-free-1";

interface SubscriptionInput {
  readonly id: string;
  readonly status: string;
  readonly metadata?: Record<string, string> | null;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end: boolean;
  readonly items: {
    readonly data: readonly {
      readonly price: { readonly id: string };
      readonly quantity?: number | null;
      readonly current_period_end?: number | null;
    }[];
  };
}

interface BillingCandidate {
  readonly orgId: string;
  readonly stripeSubscriptionId: string | null;
}

interface StripeBillingCandidate {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
}

interface AtomGrantCandidate {
  readonly orgId: string;
}

interface ConcurrencyCandidate {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
}

interface UsageAllowanceCandidate {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
}

interface DowngradedSubscription {
  readonly orgId: string;
  readonly subscriptionId: string | null;
  readonly status: string | null;
}

interface ExpiredConcurrencySubscription {
  readonly orgId: string;
  readonly subscriptionId: string;
  readonly status: string | null;
}

interface ReconciledUsageAllowance {
  readonly orgId: string;
  readonly subscriptionId: string;
  readonly status: string | null;
}

interface UsageAllowanceCandidateRow {
  readonly orgId: string;
  readonly stripeSubscriptionId: string | null;
}

interface ReconcileCandidateRows {
  readonly candidates: readonly BillingCandidate[];
  readonly atomGrantCandidates: readonly AtomGrantCandidate[];
  readonly concurrencyCandidates: readonly ConcurrencyCandidate[];
  readonly usageAllowanceCandidates: readonly UsageAllowanceCandidateRow[];
}

interface ReconcileBillingContext {
  readonly db: Db;
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly now: Date;
  readonly staleBefore: Date;
  readonly signal: AbortSignal;
}

type ReconcileTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function subscriptionPeriodEnd(subscription: SubscriptionInput): Date | null {
  const periodEndUnix = subscription.items.data[0]?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function concurrencySubscriptionItem(subscription: SubscriptionInput):
  | {
      readonly price: { readonly id: string };
      readonly quantity?: number | null;
      readonly current_period_end?: number | null;
    }
  | undefined {
  return subscription.items.data.find((item) => {
    return isConcurrencyPriceId(item.price.id);
  });
}

function concurrencySubscriptionPeriodEnd(
  subscription: SubscriptionInput,
): Date | null {
  const periodEndUnix =
    concurrencySubscriptionItem(subscription)?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function concurrencySubscriptionSlots(
  subscription: SubscriptionInput,
): number | null {
  const quantity = concurrencySubscriptionItem(subscription)?.quantity;
  return typeof quantity === "number" && quantity > 0 ? quantity : null;
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

function usageAllowanceSubscriptionEnd(
  subscription: SubscriptionInput,
): Date | null {
  const periodEnd = subscriptionPeriodEnd(subscription);
  const cancelAt = subscriptionCancelAt(subscription);
  if (!periodEnd) {
    return null;
  }
  return cancelAt && cancelAt < periodEnd ? cancelAt : periodEnd;
}

function subscriptionCanRefreshPaidThrough(
  subscription: SubscriptionInput,
): boolean {
  return ENTITLEMENT_PERIOD_REFRESH_STATUSES.includes(
    subscription.status as (typeof ENTITLEMENT_PERIOD_REFRESH_STATUSES)[number],
  );
}

function subscriptionIsPaymentFailed(subscription: SubscriptionInput): boolean {
  return PAYMENT_FAILED_SUBSCRIPTION_STATUSES.includes(
    subscription.status as (typeof PAYMENT_FAILED_SUBSCRIPTION_STATUSES)[number],
  );
}

function subscriptionIsTerminalUsageAllowance(
  subscription: SubscriptionInput,
): boolean {
  return TERMINAL_USAGE_ALLOWANCE_STATUSES.includes(
    subscription.status as (typeof TERMINAL_USAGE_ALLOWANCE_STATUSES)[number],
  );
}

function knownOrgTier(value: string): OrgTier {
  switch (value) {
    case "free":
    case "limited-free-1":
    case "pro-suspend":
    case "pro":
    case "team":
    case "custom": {
      return value;
    }
    default: {
      throw new Error(`Unknown org tier: ${value}`);
    }
  }
}

async function upsertStripeSubscriptionPlanSnapshot(
  tx: ReconcileTx,
  args: {
    readonly orgId: string;
    readonly tier: OrgTier;
    readonly subscription: SubscriptionInput;
    readonly stripeSubscriptionId: string | null;
    readonly stripePriceId?: string | null;
    readonly status?: string;
  },
): Promise<void> {
  const scheduledEnd = subscriptionScheduledEnd(args.subscription);
  const cancelAt = subscriptionWillCancel(args.subscription)
    ? scheduledEnd
    : null;
  await upsertOrgPlanEntitlement(tx, {
    orgId: args.orgId,
    tier: args.tier,
    source: "stripe_subscription",
    status: args.status,
    stripeSubscriptionId: args.stripeSubscriptionId,
    stripePriceId: args.stripePriceId ?? null,
    currentPeriodEnd: scheduledEnd,
    cancelAt,
    expiresAt: cancelAt,
    sourceMetadata: args.subscription.metadata ?? {},
  });
}

function currentUsageAllowanceCandidateWhere(
  candidate: UsageAllowanceCandidate,
) {
  return and(
    eq(
      orgUsageAllowanceEntitlements.stripeSubscriptionId,
      candidate.stripeSubscriptionId,
    ),
    inArray(orgUsageAllowanceEntitlements.status, [
      ...USAGE_ALLOWANCE_RECONCILE_STATUSES,
    ]),
  );
}

async function updateUsageAllowanceCandidate(
  context: ReconcileBillingContext,
  candidate: UsageAllowanceCandidate,
  values: {
    readonly status: string;
    readonly expiresAt: Date;
  },
): Promise<ReconciledUsageAllowance[]> {
  const rows = await context.db
    .update(orgUsageAllowanceEntitlements)
    .set({
      status: values.status,
      expiresAt: values.expiresAt,
      updatedAt: context.now,
    })
    .where(currentUsageAllowanceCandidateWhere(candidate))
    .returning({
      orgId: orgUsageAllowanceEntitlements.orgId,
      subscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
      status: orgUsageAllowanceEntitlements.status,
    });
  context.signal.throwIfAborted();
  return rows.map((row) => {
    return {
      ...row,
      subscriptionId: row.subscriptionId ?? candidate.stripeSubscriptionId,
    };
  });
}

function priceIdsForTier(tier: SubscriptionPriceTier): readonly string[] {
  switch (tier) {
    case "pro": {
      return env("ZERO_PRICE_PRO") ?? [];
    }
    case "team": {
      return env("ZERO_PRICE_TEAM") ?? [];
    }
  }
}

function tierFromPriceId(priceId: string): OrgTier {
  for (const tier of STRIPE_SUBSCRIPTION_PRICE_TIERS) {
    if (priceIdsForTier(tier).includes(priceId)) {
      return tier;
    }
  }
  throw new Error(`Unknown Stripe price ID: ${priceId}`);
}

interface SyncedBillingFields {
  readonly subscriptionStatus: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly updatedAt: Date;
  readonly currentPeriodEnd?: Date;
}

function currentBillingCandidateWhere(candidate: StripeBillingCandidate) {
  return and(
    eq(orgMetadata.orgId, candidate.orgId),
    eq(orgMetadata.stripeSubscriptionId, candidate.stripeSubscriptionId),
    inArray(orgMetadata.tier, ["pro", "team"]),
    inArray(orgMetadata.subscriptionStatus, [
      ...PAYMENT_FAILED_SUBSCRIPTION_STATUSES,
    ]),
  );
}

async function reconcileCanceledBillingCandidate(
  context: ReconcileBillingContext,
  candidate: StripeBillingCandidate,
  subscription: SubscriptionInput,
): Promise<DowngradedSubscription[]> {
  const { db, now, signal } = context;
  const rows = await db.transaction(async (tx) => {
    return await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
            subscriptionStatus: "canceled",
            stripeSubscriptionId: null,
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            updatedAt: now,
          })
          .where(currentBillingCandidateWhere(candidate))
          .returning({
            orgId: orgMetadata.orgId,
            status: orgMetadata.subscriptionStatus,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        await upsertOrgPlanEntitlement(writeTx, {
          orgId: row.orgId,
          tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
          source: "stripe_subscription",
          sourceMetadata: subscription.metadata ?? {},
        });
      },
    });
  });
  signal.throwIfAborted();

  return rows.map((row) => {
    return { ...row, subscriptionId: candidate.stripeSubscriptionId };
  });
}

async function refreshRecoveredBillingCandidate(
  context: ReconcileBillingContext,
  candidate: StripeBillingCandidate,
  subscription: SubscriptionInput,
  syncedFields: SyncedBillingFields,
): Promise<void> {
  const { db, signal } = context;
  const priceId = subscription.items.data[0]?.price.id;
  const tier = priceId ? tierFromPriceId(priceId) : undefined;

  await db.transaction(async (tx) => {
    await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            ...syncedFields,
            ...(tier ? { tier } : {}),
          })
          .where(currentBillingCandidateWhere(candidate))
          .returning({
            orgId: orgMetadata.orgId,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        if (!tier) {
          return;
        }
        await upsertStripeSubscriptionPlanSnapshot(writeTx, {
          orgId: row.orgId,
          tier,
          subscription,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          stripePriceId: priceId,
          status: subscription.status,
        });
      },
    });
  });
  signal.throwIfAborted();
}

async function refreshPaymentFailedPaidThroughCandidate(
  context: ReconcileBillingContext,
  candidate: StripeBillingCandidate,
  subscription: SubscriptionInput,
  syncedFields: SyncedBillingFields,
): Promise<void> {
  const { db, signal } = context;
  await db.transaction(async (tx) => {
    await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set(syncedFields)
          .where(currentBillingCandidateWhere(candidate))
          .returning({
            orgId: orgMetadata.orgId,
            tier: orgMetadata.tier,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        await upsertStripeSubscriptionPlanSnapshot(writeTx, {
          orgId: row.orgId,
          tier: knownOrgTier(row.tier),
          subscription,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          stripePriceId: subscription.items.data[0]?.price.id ?? null,
          status: subscription.status,
        });
      },
    });
  });
  signal.throwIfAborted();
}

async function downgradePaymentFailedBillingCandidate(
  context: ReconcileBillingContext,
  candidate: StripeBillingCandidate,
  subscription: SubscriptionInput,
  syncedFields: SyncedBillingFields,
): Promise<DowngradedSubscription[]> {
  const { db, signal } = context;
  const rows = await db.transaction(async (tx) => {
    return await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
            ...syncedFields,
          })
          .where(currentBillingCandidateWhere(candidate))
          .returning({
            orgId: orgMetadata.orgId,
            subscriptionId: orgMetadata.stripeSubscriptionId,
            status: orgMetadata.subscriptionStatus,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        await upsertStripeSubscriptionPlanSnapshot(writeTx, {
          orgId: row.orgId,
          tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
          subscription,
          stripeSubscriptionId: row.subscriptionId,
          stripePriceId: subscription.items.data[0]?.price.id ?? null,
        });
      },
    });
  });
  signal.throwIfAborted();
  return rows;
}

async function reconcileBillingCandidate(
  context: ReconcileBillingContext,
  candidate: BillingCandidate,
): Promise<DowngradedSubscription[]> {
  const { stripe, now, staleBefore, signal } = context;
  if (!candidate.stripeSubscriptionId) {
    return [];
  }
  const stripeCandidate: StripeBillingCandidate = {
    orgId: candidate.orgId,
    stripeSubscriptionId: candidate.stripeSubscriptionId,
  };

  const subscription = (await stripe.subscriptions.retrieve(
    stripeCandidate.stripeSubscriptionId,
  )) as SubscriptionInput;
  signal.throwIfAborted();

  const stripePeriodEnd = subscriptionPeriodEnd(subscription);
  const scheduledEnd = subscriptionScheduledEnd(subscription);
  const syncedFields = {
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscriptionWillCancel(subscription),
    updatedAt: now,
    ...(scheduledEnd ? { currentPeriodEnd: scheduledEnd } : {}),
  };

  if (subscription.status === "canceled") {
    return await reconcileCanceledBillingCandidate(
      context,
      stripeCandidate,
      subscription,
    );
  }

  if (!subscriptionIsPaymentFailed(subscription)) {
    if (!subscriptionCanRefreshPaidThrough(subscription)) {
      L.warn(
        "payment-failed local subscription has unexpected Stripe status; skipping downgrade",
        {
          orgId: candidate.orgId,
          subscriptionId: stripeCandidate.stripeSubscriptionId,
          status: subscription.status,
        },
      );
      return [];
    }

    await refreshRecoveredBillingCandidate(
      context,
      stripeCandidate,
      subscription,
      syncedFields,
    );
    return [];
  }

  if (!stripePeriodEnd) {
    L.warn(
      "payment-failed subscription missing paid-through in Stripe; downgrading",
      {
        orgId: candidate.orgId,
        subscriptionId: stripeCandidate.stripeSubscriptionId,
        status: subscription.status,
      },
    );
  } else if (stripePeriodEnd > staleBefore) {
    await refreshPaymentFailedPaidThroughCandidate(
      context,
      stripeCandidate,
      subscription,
      syncedFields,
    );
    return [];
  }

  return await downgradePaymentFailedBillingCandidate(
    context,
    stripeCandidate,
    subscription,
    syncedFields,
  );
}

async function expireOrgCredits(
  db: Db,
  orgId: string,
  now: Date,
): Promise<number> {
  return await db.transaction(async (tx) => {
    const expired = await tx
      .select({
        id: creditExpiresRecord.id,
        remaining: creditExpiresRecord.remaining,
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, orgId),
          lte(creditExpiresRecord.expiresAt, now),
          gt(creditExpiresRecord.remaining, 0),
        ),
      )
      .for("update");

    const totalExpired = expired.reduce((sum, record) => {
      return sum + record.remaining;
    }, 0);
    if (totalExpired <= 0) {
      return 0;
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
        updatedAt: now,
      })
      .where(eq(orgMetadata.orgId, orgId));

    return totalExpired;
  });
}

async function reconcileAtomGrantCandidate(
  context: ReconcileBillingContext,
  candidate: AtomGrantCandidate,
): Promise<DowngradedSubscription[]> {
  const { db, now, signal } = context;
  await expireOrgCredits(db, candidate.orgId, now);
  signal.throwIfAborted();

  const rows = await db.transaction(async (tx) => {
    return await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
            subscriptionStatus: "expired",
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            pendingSubscriptionScheduleId: null,
            pendingSubscriptionTargetTier: null,
            pendingSubscriptionChangeAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(orgMetadata.orgId, candidate.orgId),
              inArray(orgMetadata.tier, PAID_TIERS),
              isNull(orgMetadata.stripeSubscriptionId),
              eq(
                orgMetadata.subscriptionStatus,
                ATOM_GRANT_SUBSCRIPTION_STATUS,
              ),
              isNotNull(orgMetadata.currentPeriodEnd),
              lte(orgMetadata.currentPeriodEnd, now),
            ),
          )
          .returning({
            orgId: orgMetadata.orgId,
            subscriptionId: orgMetadata.stripeSubscriptionId,
            status: orgMetadata.subscriptionStatus,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        await upsertOrgPlanEntitlement(writeTx, {
          orgId: row.orgId,
          tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
          source: "stripe_atom_grant",
        });
      },
    });
  });
  signal.throwIfAborted();
  return rows;
}

async function reconcileConcurrencyCandidate(
  context: ReconcileBillingContext,
  candidate: ConcurrencyCandidate,
): Promise<ExpiredConcurrencySubscription[]> {
  const { db, stripe, now, staleBefore, signal } = context;
  const subscription = (await stripe.subscriptions.retrieve(
    candidate.stripeSubscriptionId,
  )) as SubscriptionInput;
  signal.throwIfAborted();

  const item = concurrencySubscriptionItem(subscription);
  const periodEnd = concurrencySubscriptionPeriodEnd(subscription);
  const slots = concurrencySubscriptionSlots(subscription);
  const isPaymentFailed = subscriptionIsPaymentFailed(subscription);
  const syncedFields = {
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscriptionWillCancel(subscription),
    updatedAt: now,
    ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    ...(item ? { stripePriceId: item.price.id } : {}),
    ...(slots ? { slots } : {}),
  };
  const currentCandidate = and(
    eq(
      orgConcurrencySubscriptions.stripeSubscriptionId,
      candidate.stripeSubscriptionId,
    ),
    inArray(orgConcurrencySubscriptions.subscriptionStatus, [
      ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
    ]),
  );

  if (subscription.status === "canceled") {
    const rows = await db
      .update(orgConcurrencySubscriptions)
      .set({
        subscriptionStatus: "canceled",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: now,
        updatedAt: now,
      })
      .where(currentCandidate)
      .returning({
        orgId: orgConcurrencySubscriptions.orgId,
        subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
        status: orgConcurrencySubscriptions.subscriptionStatus,
      });
    signal.throwIfAborted();
    return rows;
  }

  if (!isPaymentFailed) {
    if (!item) {
      L.warn(
        "payment-failed concurrency subscription has unexpected Stripe price; skipping",
        {
          orgId: candidate.orgId,
          subscriptionId: candidate.stripeSubscriptionId,
          status: subscription.status,
        },
      );
      return [];
    }

    await db
      .update(orgConcurrencySubscriptions)
      .set(syncedFields)
      .where(currentCandidate);
    signal.throwIfAborted();
    return [];
  }

  if (!periodEnd) {
    L.warn(
      "payment-failed concurrency subscription missing paid-through in Stripe; expiring",
      {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        status: subscription.status,
      },
    );
  } else if (periodEnd > staleBefore) {
    await db
      .update(orgConcurrencySubscriptions)
      .set(syncedFields)
      .where(currentCandidate);
    signal.throwIfAborted();
    return [];
  }

  const rows = await db
    .update(orgConcurrencySubscriptions)
    .set({
      ...syncedFields,
      subscriptionStatus: subscription.status,
    })
    .where(currentCandidate)
    .returning({
      orgId: orgConcurrencySubscriptions.orgId,
      subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
      status: orgConcurrencySubscriptions.subscriptionStatus,
    });
  signal.throwIfAborted();
  return rows;
}

async function reconcileUsageAllowanceCandidate(
  context: ReconcileBillingContext,
  candidate: UsageAllowanceCandidate,
): Promise<ReconciledUsageAllowance[]> {
  const { stripe, now, staleBefore, signal } = context;
  const subscription = (await stripe.subscriptions.retrieve(
    candidate.stripeSubscriptionId,
  )) as SubscriptionInput;
  signal.throwIfAborted();

  const periodEnd = usageAllowanceSubscriptionEnd(subscription);
  const canRefreshPaidThrough = subscriptionCanRefreshPaidThrough(subscription);
  const isPaymentFailed = subscriptionIsPaymentFailed(subscription);

  if (subscriptionIsTerminalUsageAllowance(subscription)) {
    return await updateUsageAllowanceCandidate(context, candidate, {
      status: "canceled",
      expiresAt: now,
    });
  }

  if (!isPaymentFailed) {
    if (!canRefreshPaidThrough) {
      L.warn("expired usage allowance has unexpected Stripe status; skipping", {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        status: subscription.status,
      });
      return [];
    }

    if (!periodEnd || periodEnd <= now) {
      L.warn(
        "expired usage allowance subscription missing future paid-through in Stripe",
        {
          orgId: candidate.orgId,
          subscriptionId: candidate.stripeSubscriptionId,
          status: subscription.status,
          periodEnd,
        },
      );
      return [];
    }

    return await updateUsageAllowanceCandidate(context, candidate, {
      status: subscription.status,
      expiresAt: periodEnd,
    });
  }

  if (!periodEnd) {
    L.warn(
      "payment-failed usage allowance subscription missing paid-through in Stripe; expiring",
      {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        status: subscription.status,
      },
    );
  } else if (periodEnd > staleBefore) {
    return await updateUsageAllowanceCandidate(context, candidate, {
      status: subscription.status,
      expiresAt: periodEnd,
    });
  }

  return await updateUsageAllowanceCandidate(context, candidate, {
    status: "canceled",
    expiresAt: now,
  });
}

async function loadReconcileCandidateRows(
  db: Db,
  now: Date,
  staleBefore: Date,
): Promise<ReconcileCandidateRows> {
  const [
    candidates,
    atomGrantCandidates,
    concurrencyCandidates,
    usageAllowanceCandidates,
  ] = await Promise.all([
    db
      .select({
        orgId: orgMetadata.orgId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .where(
        and(
          inArray(orgMetadata.tier, PAID_TIERS),
          isNotNull(orgMetadata.stripeSubscriptionId),
          inArray(orgMetadata.subscriptionStatus, [
            ...PAYMENT_FAILED_SUBSCRIPTION_STATUSES,
          ]),
          or(
            and(
              isNull(orgMetadata.currentPeriodEnd),
              lte(orgMetadata.updatedAt, staleBefore),
            ),
            lte(orgMetadata.currentPeriodEnd, staleBefore),
          ),
        ),
      ),
    db
      .select({
        orgId: orgMetadata.orgId,
      })
      .from(orgMetadata)
      .where(
        and(
          inArray(orgMetadata.tier, PAID_TIERS),
          isNull(orgMetadata.stripeSubscriptionId),
          eq(orgMetadata.subscriptionStatus, ATOM_GRANT_SUBSCRIPTION_STATUS),
          isNotNull(orgMetadata.currentPeriodEnd),
          lte(orgMetadata.currentPeriodEnd, now),
        ),
      ),
    db
      .select({
        orgId: orgConcurrencySubscriptions.orgId,
        stripeSubscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
      })
      .from(orgConcurrencySubscriptions)
      .where(
        and(
          inArray(orgConcurrencySubscriptions.subscriptionStatus, [
            ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
          ]),
          or(
            and(
              isNull(orgConcurrencySubscriptions.currentPeriodEnd),
              lte(orgConcurrencySubscriptions.updatedAt, staleBefore),
            ),
            lte(orgConcurrencySubscriptions.currentPeriodEnd, staleBefore),
          ),
        ),
      ),
    db
      .select({
        orgId: orgUsageAllowanceEntitlements.orgId,
        stripeSubscriptionId:
          orgUsageAllowanceEntitlements.stripeSubscriptionId,
      })
      .from(orgUsageAllowanceEntitlements)
      .where(
        and(
          isNotNull(orgUsageAllowanceEntitlements.stripeSubscriptionId),
          inArray(orgUsageAllowanceEntitlements.status, [
            ...USAGE_ALLOWANCE_RECONCILE_STATUSES,
          ]),
          isNotNull(orgUsageAllowanceEntitlements.expiresAt),
          lte(orgUsageAllowanceEntitlements.expiresAt, now),
        ),
      ),
  ]);

  return {
    candidates,
    atomGrantCandidates,
    concurrencyCandidates,
    usageAllowanceCandidates,
  };
}

export const reconcileBillingEntitlements$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<{ readonly downgraded: number }> => {
    const db = set(writeDb$);
    const stripe = getStripeClient();
    const now = nowDate();
    const staleBefore = new Date(
      now.getTime() - PAYMENT_FAILURE_DOWNGRADE_GRACE_MS,
    );

    const {
      candidates,
      atomGrantCandidates,
      concurrencyCandidates,
      usageAllowanceCandidates,
    } = await loadReconcileCandidateRows(db, now, staleBefore);
    signal.throwIfAborted();

    const downgraded: DowngradedSubscription[] = [];
    const expiredConcurrency: ExpiredConcurrencySubscription[] = [];
    const reconciledUsageAllowances: ReconciledUsageAllowance[] = [];

    for (const candidate of candidates) {
      downgraded.push(
        ...(await reconcileBillingCandidate(
          { db, stripe, now, staleBefore, signal },
          candidate,
        )),
      );
    }
    for (const candidate of atomGrantCandidates) {
      downgraded.push(
        ...(await reconcileAtomGrantCandidate(
          { db, stripe, now, staleBefore, signal },
          candidate,
        )),
      );
    }
    for (const candidate of concurrencyCandidates) {
      expiredConcurrency.push(
        ...(await reconcileConcurrencyCandidate(
          { db, stripe, now, staleBefore, signal },
          candidate,
        )),
      );
    }
    for (const candidate of usageAllowanceCandidates) {
      if (!candidate.stripeSubscriptionId) {
        throw new Error(
          `Usage allowance entitlement for org ${candidate.orgId} is missing its Stripe subscription ID`,
        );
      }
      reconciledUsageAllowances.push(
        ...(await reconcileUsageAllowanceCandidate(
          { db, stripe, now, staleBefore, signal },
          {
            orgId: candidate.orgId,
            stripeSubscriptionId: candidate.stripeSubscriptionId,
          },
        )),
      );
    }

    for (const orgId of new Set(
      downgraded.map((subscription) => {
        return subscription.orgId;
      }),
    )) {
      await disableIneligibleWorkflowWebhookAutomationsForOrg(db, {
        orgId,
        signal,
      });
      signal.throwIfAborted();
    }

    if (downgraded.length > 0) {
      L.warn("stale payment-failed subscriptions downgraded", {
        count: downgraded.length,
        subscriptionIds: downgraded.slice(0, 10).map((row) => {
          return row.subscriptionId;
        }),
      });
    }
    if (expiredConcurrency.length > 0) {
      L.warn("stale payment-failed concurrency subscriptions expired", {
        count: expiredConcurrency.length,
        subscriptionIds: expiredConcurrency.slice(0, 10).map((row) => {
          return row.subscriptionId;
        }),
      });
    }
    if (reconciledUsageAllowances.length > 0) {
      L.warn("expired usage allowances reconciled from Stripe", {
        count: reconciledUsageAllowances.length,
        subscriptionIds: reconciledUsageAllowances.slice(0, 10).map((row) => {
          return row.subscriptionId;
        }),
      });
    }

    return { downgraded: downgraded.length };
  },
);
