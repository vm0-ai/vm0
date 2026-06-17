import { orgConcurrencyEntitlements } from "@vm0/db/schema/org-concurrency-entitlement";
import { and, gt, lte, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../external/time";
import type { Db } from "../external/db";

export const CONCURRENCY_SUBSCRIPTION_PURPOSE = "concurrency_subscription";

type ReadDb = Pick<Db, "select">;

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

export function totalConcurrencyLimit(args: {
  readonly baseLimit: number;
  readonly paidSlots: number;
}): number {
  if (!Number.isFinite(args.baseLimit)) {
    return Number.POSITIVE_INFINITY;
  }
  return args.baseLimit + args.paidSlots;
}

export async function activePaidConcurrencySlots(
  db: ReadDb,
  orgId: string,
  at: Date = nowDate(),
): Promise<number> {
  const [row] = await db
    .select({
      slots: sql<number>`COALESCE(SUM(${orgConcurrencyEntitlements.slots}), 0)::int`,
    })
    .from(orgConcurrencyEntitlements)
    .where(
      and(
        lte(orgConcurrencyEntitlements.startsAt, at),
        gt(orgConcurrencyEntitlements.expiresAt, at),
        sql`${orgConcurrencyEntitlements.orgId} = ${orgId}`,
      ),
    );

  return Number(row?.slots ?? 0);
}
