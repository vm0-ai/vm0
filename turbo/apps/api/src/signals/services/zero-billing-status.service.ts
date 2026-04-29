import { computed, type Computed } from "ccstate";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";

const TIER_MONTHLY_CREDITS = Object.freeze<Record<PlanCreditTier, number>>({
  pro: 20_000,
  team: 120_000,
});

type CreditBreakdownCategory = "plan" | "free" | "promotional" | "payAsYouGo";
type PlanCreditTier = "pro" | "team";

interface CreditBreakdownSegment {
  category: CreditBreakdownCategory;
  label: string;
  credits: number;
  tier?: PlanCreditTier;
}

interface ActiveCreditRecord {
  id: string;
  source: string;
  amount: number;
  remaining: number;
  expiresAt: Date;
  createdAt: Date;
}

interface BillingOrgRow {
  tier: string;
  credits: number;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeSubscriptionId: string | null;
  autoRechargeEnabled: boolean;
  autoRechargeThreshold: number | null;
  autoRechargeAmount: number | null;
}

interface BillingStatusResponse {
  tier: string;
  credits: number;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
  autoRecharge: {
    enabled: boolean;
    threshold: number | null;
    amount: number | null;
  };
  creditExpiry: {
    expiringNextCycle: number;
    nextExpiryDate: string | null;
  };
  creditBreakdown: CreditBreakdownSegment[];
  creditGrants: {
    id: string;
    source: string;
    label: string;
    amount: number;
    remaining: number;
    createdAt: string;
    expiresAt: string;
  }[];
}

const DEFAULT_BILLING_ORG = Object.freeze<BillingOrgRow>({
  tier: "free",
  credits: 0,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  stripeSubscriptionId: null,
  autoRechargeEnabled: false,
  autoRechargeThreshold: null,
  autoRechargeAmount: null,
});

function planTierFromAmount(amount: number): PlanCreditTier | null {
  if (amount === TIER_MONTHLY_CREDITS.team) {
    return "team";
  }
  if (amount === TIER_MONTHLY_CREDITS.pro) {
    return "pro";
  }
  return null;
}

function labelForCreditRecord(
  record: Pick<ActiveCreditRecord, "source" | "amount">,
): string {
  if (record.source === "subscription_renewal") {
    const planTier = planTierFromAmount(record.amount);
    if (planTier === "team") {
      return "Team plan";
    }
    if (planTier === "pro") {
      return "Pro plan";
    }
    return "Plan credits";
  }
  if (record.source === "starter_grant") {
    return "Free plan";
  }
  if (record.source === "one_time_purchase") {
    return "Promotional";
  }
  if (record.source === "auto_recharge") {
    return "Pay as you go";
  }
  return "Credits";
}

function buildCreditBreakdown(args: {
  orgId: string;
  tier: string;
  displayedCredits: number;
  records: readonly ActiveCreditRecord[];
}): CreditBreakdownSegment[] {
  const { tier, displayedCredits, records } = args;

  const segmentKey = (
    category: CreditBreakdownCategory,
    tierKey?: string,
  ): string => {
    return tierKey ? `${category}:${tierKey}` : category;
  };

  const byKey = new Map<string, CreditBreakdownSegment>();
  const addSegment = (segment: CreditBreakdownSegment): void => {
    const key = segmentKey(segment.category, segment.tier);
    const existing = byKey.get(key);
    if (existing) {
      existing.credits += segment.credits;
    } else {
      byKey.set(key, { ...segment });
    }
  };

  let trackedTotal = 0;
  for (const record of records) {
    trackedTotal += record.remaining;
    if (record.source === "subscription_renewal") {
      const planTier = planTierFromAmount(record.amount);
      if (!planTier) {
        trackedTotal -= record.remaining;
        continue;
      }
      addSegment({
        category: "plan",
        label: planTier === "team" ? "Team plan" : "Pro plan",
        credits: record.remaining,
        tier: planTier,
      });
    } else if (record.source === "starter_grant") {
      addSegment({
        category: "free",
        label: "Free plan",
        credits: record.remaining,
      });
    } else if (record.source === "one_time_purchase") {
      addSegment({
        category: "promotional",
        label: "Promotional",
        credits: record.remaining,
      });
    } else if (record.source === "auto_recharge") {
      addSegment({
        category: "payAsYouGo",
        label: "Pay as you go",
        credits: record.remaining,
      });
    }
  }

  const untracked = Math.max(displayedCredits - trackedTotal, 0);
  if (untracked > 0) {
    addSegment({
      category: tier === "free" ? "free" : "payAsYouGo",
      label: tier === "free" ? "Free plan" : "Pay as you go",
      credits: untracked,
    });
  }

  const categoryOrder: CreditBreakdownCategory[] = [
    "plan",
    "free",
    "promotional",
    "payAsYouGo",
  ];
  const planTierOrder: Record<PlanCreditTier, number> = {
    pro: 0,
    team: 1,
  };
  const segments = Array.from(byKey.values());
  segments.sort((a, b) => {
    const categoryDelta =
      categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    if (a.category === "plan" && b.category === "plan") {
      return planTierOrder[a.tier ?? "team"] - planTierOrder[b.tier ?? "team"];
    }
    return 0;
  });
  return segments;
}

function creditGrants(records: readonly ActiveCreditRecord[]) {
  return records.map((record) => {
    return {
      id: record.id,
      source: record.source,
      label: labelForCreditRecord(record),
      amount: record.amount,
      remaining: record.remaining,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  });
}

function creditExpiry(records: readonly ActiveCreditRecord[]): {
  expiringNextCycle: number;
  nextExpiryDate: string | null;
} {
  const expiryRecords = [...records].sort((a, b) => {
    return a.expiresAt.getTime() - b.expiresAt.getTime();
  });
  const firstExpiry = expiryRecords[0]?.expiresAt ?? null;
  if (!firstExpiry) {
    return { expiringNextCycle: 0, nextExpiryDate: null };
  }

  const expiringNextCycle = expiryRecords
    .filter((record) => {
      return record.expiresAt.getTime() === firstExpiry.getTime();
    })
    .reduce((sum, record) => {
      return sum + record.remaining;
    }, 0);

  return {
    expiringNextCycle,
    nextExpiryDate: firstExpiry.toISOString(),
  };
}

function billingStatusResponse(args: {
  orgId: string;
  org: BillingOrgRow | undefined;
  unsettledExpired: number;
  activeRecords: readonly ActiveCreditRecord[];
}): BillingStatusResponse {
  const org = args.org ?? DEFAULT_BILLING_ORG;
  const displayedCredits = Math.max(org.credits - args.unsettledExpired, 0);

  return {
    tier: org.tier,
    credits: displayedCredits,
    subscriptionStatus: org.subscriptionStatus,
    currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: org.cancelAtPeriodEnd,
    hasSubscription: org.stripeSubscriptionId !== null,
    autoRecharge: {
      enabled: org.autoRechargeEnabled,
      threshold: org.autoRechargeThreshold,
      amount: org.autoRechargeAmount,
    },
    creditExpiry: creditExpiry(args.activeRecords),
    creditBreakdown: buildCreditBreakdown({
      orgId: args.orgId,
      tier: org.tier,
      displayedCredits,
      records: args.activeRecords,
    }),
    creditGrants: creditGrants(args.activeRecords),
  };
}

export function zeroBillingStatus(
  orgId: string,
): Computed<Promise<BillingStatusResponse>> {
  return computed(async (get): Promise<BillingStatusResponse> => {
    const db = get(db$);
    const currentTime = nowDate();
    const [org, unsettledExpiredRow, activeRecords] = await Promise.all([
      db
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
        .limit(1),
      db
        .select({
          total: sql<number>`COALESCE(SUM(${creditExpiresRecord.remaining}), 0)::int`,
        })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, orgId),
            lte(creditExpiresRecord.expiresAt, currentTime),
            gt(creditExpiresRecord.remaining, 0),
          ),
        ),
      db
        .select({
          id: creditExpiresRecord.id,
          source: creditExpiresRecord.source,
          amount: creditExpiresRecord.amount,
          remaining: creditExpiresRecord.remaining,
          expiresAt: creditExpiresRecord.expiresAt,
          createdAt: creditExpiresRecord.createdAt,
        })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, orgId),
            gt(creditExpiresRecord.remaining, 0),
            gt(creditExpiresRecord.expiresAt, currentTime),
          ),
        )
        .orderBy(desc(creditExpiresRecord.createdAt)),
    ]);

    return billingStatusResponse({
      orgId,
      org: org[0],
      unsettledExpired: unsettledExpiredRow[0]?.total ?? 0,
      activeRecords,
    });
  });
}
