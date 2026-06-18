import { orgConcurrencySubscriptions } from "@vm0/db/schema/org-concurrency-subscription";
import { and, eq, gt, inArray, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../external/time";
import type { Db } from "../external/db";

export const CONCURRENCY_SUBSCRIPTION_PURPOSE = "concurrency_subscription";
const CONCURRENCY_SUBSCRIPTION_ACTIVE_STATUSES = [
  "active",
  "trialing",
] as const;
export const CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES = [
  "past_due",
  "unpaid",
] as const;
const CONCURRENCY_PAYMENT_FAILURE_GRACE_MS = 24 * 60 * 60 * 1000;

type ReadDb = Pick<Db, "select">;

export interface ActiveConcurrencySubscription {
  readonly id: string;
  readonly quantity: number;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
}

function dbTimestamp(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

export function activeConcurrencyPriceId(): string | undefined {
  return env("ZERO_PRICE_CONCURRENCY")?.[0];
}

export function isConcurrencyPriceId(priceId: string): boolean {
  return env("ZERO_PRICE_CONCURRENCY")?.includes(priceId) ?? false;
}

export function cappedBaseConcurrencyLimit(tierLimit: number): number {
  const cap = env("CONCURRENT_RUN_LIMIT_CAP");
  if (cap === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (tierLimit === 0) {
    return 0;
  }
  return cap === undefined ? tierLimit : Math.min(tierLimit, cap);
}

function tierBaseConcurrencyLimit(tier: string | null | undefined): number {
  switch (tier) {
    case "free": {
      return 1;
    }
    case "pro": {
      return 2;
    }
    case "team": {
      return 10;
    }
    case "pro-suspend":
    default: {
      return 0;
    }
  }
}

export function displayBaseConcurrencyLimitForTier(
  tier: string | null | undefined,
): number {
  const tierLimit = tierBaseConcurrencyLimit(tier);
  const cap = env("CONCURRENT_RUN_LIMIT_CAP");
  if (cap === undefined || cap === 0 || tierLimit === 0) {
    return tierLimit;
  }
  return Math.min(tierLimit, cap);
}

export function totalConcurrencyLimit(args: {
  readonly baseLimit: number;
  readonly paidSlots: number;
}): number {
  if (!Number.isFinite(args.baseLimit)) {
    return Number.POSITIVE_INFINITY;
  }
  return args.baseLimit + args.paidSlots;
}

function activePaidThroughCutoff(at: Date): Date {
  return new Date(at.getTime() - CONCURRENCY_PAYMENT_FAILURE_GRACE_MS);
}

export async function activePaidConcurrencySlots(
  db: ReadDb,
  orgId: string,
  at: Date = nowDate(),
): Promise<number> {
  const [row] = await db
    .select({
      slots: sql<number>`COALESCE(SUM(${orgConcurrencySubscriptions.slots}), 0)::int`,
    })
    .from(orgConcurrencySubscriptions)
    .where(
      and(
        eq(orgConcurrencySubscriptions.orgId, orgId),
        inArray(orgConcurrencySubscriptions.subscriptionStatus, [
          ...CONCURRENCY_SUBSCRIPTION_ACTIVE_STATUSES,
          ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
        ]),
        gt(
          orgConcurrencySubscriptions.currentPeriodEnd,
          activePaidThroughCutoff(at),
        ),
      ),
    );

  return Number(row?.slots ?? 0);
}

export async function activeConcurrencySubscriptions(
  db: ReadDb,
  orgId: string,
  at: Date = nowDate(),
): Promise<readonly ActiveConcurrencySubscription[]> {
  const rows = await db
    .select({
      id: orgConcurrencySubscriptions.stripeSubscriptionId,
      quantity: orgConcurrencySubscriptions.slots,
      currentPeriodEnd: orgConcurrencySubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: orgConcurrencySubscriptions.cancelAtPeriodEnd,
    })
    .from(orgConcurrencySubscriptions)
    .where(
      and(
        eq(orgConcurrencySubscriptions.orgId, orgId),
        inArray(orgConcurrencySubscriptions.subscriptionStatus, [
          ...CONCURRENCY_SUBSCRIPTION_ACTIVE_STATUSES,
          ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
        ]),
        gt(
          orgConcurrencySubscriptions.currentPeriodEnd,
          activePaidThroughCutoff(at),
        ),
      ),
    );

  return rows
    .map((row) => {
      return {
        id: row.id,
        quantity: Number(row.quantity),
        currentPeriodEnd: dbTimestamp(row.currentPeriodEnd),
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      };
    })
    .filter((row) => {
      return row.quantity > 0;
    });
}
