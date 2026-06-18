import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { orgConcurrencySubscriptions } from "@vm0/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import {
  CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";

const L = logger("CronBillingEntitlements");
const STRIPE_SUBSCRIPTION_PRICE_TIERS = ["pro", "team"] as const;
type SubscriptionPriceTier = (typeof STRIPE_SUBSCRIPTION_PRICE_TIERS)[number];

const ENTITLEMENT_PERIOD_REFRESH_STATUSES = ["active", "trialing"] as const;
const PAYMENT_FAILED_SUBSCRIPTION_STATUSES = ["past_due", "unpaid"] as const;
const PAYMENT_FAILURE_DOWNGRADE_GRACE_MS = 24 * 60 * 60 * 1000;

interface SubscriptionInput {
  readonly id: string;
  readonly status: string;
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

interface ConcurrencyCandidate {
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

interface ReconcileBillingContext {
  readonly db: Db;
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly now: Date;
  readonly staleBefore: Date;
  readonly signal: AbortSignal;
}

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

async function reconcileBillingCandidate(
  context: ReconcileBillingContext,
  candidate: BillingCandidate,
): Promise<DowngradedSubscription[]> {
  const { db, stripe, now, staleBefore, signal } = context;
  if (!candidate.stripeSubscriptionId) {
    return [];
  }

  const subscription = (await stripe.subscriptions.retrieve(
    candidate.stripeSubscriptionId,
  )) as SubscriptionInput;
  signal.throwIfAborted();

  const stripePeriodEnd = subscriptionPeriodEnd(subscription);
  const scheduledEnd = subscriptionScheduledEnd(subscription);
  const canRefreshPaidThrough = subscriptionCanRefreshPaidThrough(subscription);
  const isPaymentFailed = subscriptionIsPaymentFailed(subscription);
  const syncedFields = {
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscriptionWillCancel(subscription),
    updatedAt: now,
    ...(scheduledEnd ? { currentPeriodEnd: scheduledEnd } : {}),
  };

  const currentCandidate = and(
    eq(orgMetadata.orgId, candidate.orgId),
    eq(orgMetadata.stripeSubscriptionId, candidate.stripeSubscriptionId),
    inArray(orgMetadata.tier, ["pro", "team"]),
    inArray(orgMetadata.subscriptionStatus, [
      ...PAYMENT_FAILED_SUBSCRIPTION_STATUSES,
    ]),
  );

  if (subscription.status === "canceled") {
    const rows = await db
      .update(orgMetadata)
      .set({
        tier: "pro-suspend",
        subscriptionStatus: "canceled",
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        updatedAt: now,
      })
      .where(currentCandidate)
      .returning({
        orgId: orgMetadata.orgId,
        status: orgMetadata.subscriptionStatus,
      });
    signal.throwIfAborted();

    return rows.map((row) => {
      return { ...row, subscriptionId: candidate.stripeSubscriptionId };
    });
  }

  if (!isPaymentFailed) {
    if (!canRefreshPaidThrough) {
      L.warn(
        "payment-failed local subscription has unexpected Stripe status; skipping downgrade",
        {
          orgId: candidate.orgId,
          subscriptionId: candidate.stripeSubscriptionId,
          status: subscription.status,
        },
      );
      return [];
    }

    const priceId = subscription.items.data[0]?.price.id;
    const tier = priceId ? tierFromPriceId(priceId) : undefined;

    await db
      .update(orgMetadata)
      .set({
        ...syncedFields,
        ...(tier ? { tier } : {}),
      })
      .where(currentCandidate);
    signal.throwIfAborted();
    return [];
  }

  if (!stripePeriodEnd) {
    L.warn(
      "payment-failed subscription missing paid-through in Stripe; downgrading",
      {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        status: subscription.status,
      },
    );
  } else if (stripePeriodEnd > staleBefore) {
    await db.update(orgMetadata).set(syncedFields).where(currentCandidate);
    signal.throwIfAborted();
    return [];
  }

  const rows = await db
    .update(orgMetadata)
    .set({
      tier: "pro-suspend",
      ...syncedFields,
    })
    .where(currentCandidate)
    .returning({
      orgId: orgMetadata.orgId,
      subscriptionId: orgMetadata.stripeSubscriptionId,
      status: orgMetadata.subscriptionStatus,
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

    const [candidates, concurrencyCandidates] = await Promise.all([
      db
        .select({
          orgId: orgMetadata.orgId,
          stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        })
        .from(orgMetadata)
        .where(
          and(
            inArray(orgMetadata.tier, ["pro", "team"]),
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
          orgId: orgConcurrencySubscriptions.orgId,
          stripeSubscriptionId:
            orgConcurrencySubscriptions.stripeSubscriptionId,
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
    ]);
    signal.throwIfAborted();

    const downgraded: DowngradedSubscription[] = [];
    const expiredConcurrency: ExpiredConcurrencySubscription[] = [];

    for (const candidate of candidates) {
      downgraded.push(
        ...(await reconcileBillingCandidate(
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

    return { downgraded: downgraded.length };
  },
);
