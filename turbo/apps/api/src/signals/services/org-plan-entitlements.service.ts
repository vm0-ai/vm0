import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import type { OrgPlanEntitlementSourceMetadata } from "@vm0/db/jsonb-contracts/org-plan-entitlement";
import { orgPlanEntitlements } from "@vm0/db/schema/org-plan-entitlement";
import { eq } from "drizzle-orm";

import { nowDate } from "../external/time";
import type { Db } from "../external/db";
import { ORG_PLAN_ENTITLEMENT_TIER_VALUES } from "./org-plan-entitlement-tier-values";

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface UpsertOrgPlanEntitlementArgs {
  readonly orgId: string;
  readonly tier: OrgTier;
  readonly source: "stripe_subscription" | "stripe_atom_grant";
  readonly status?: string;
  readonly stripeSubscriptionId?: string | null;
  readonly stripePriceId?: string | null;
  readonly currentPeriodStart?: Date | null;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly sourceMetadata?: OrgPlanEntitlementSourceMetadata;
}

function statusForTier(tier: OrgTier): string {
  return tier === "pro-suspend" ? "suspended" : "active";
}

export async function upsertOrgPlanEntitlement(
  tx: WriteTx,
  args: UpsertOrgPlanEntitlementArgs,
): Promise<void> {
  const limits = ORG_PLAN_ENTITLEMENT_TIER_VALUES[args.tier];
  const updatedAt = nowDate();
  const values = {
    orgId: args.orgId,
    planKey: args.tier,
    planRank: limits.planRank,
    source: args.source,
    status: args.status ?? statusForTier(args.tier),
    baseConcurrencyLimit: limits.baseConcurrencyLimit,
    canBuyConcurrency: limits.canBuyConcurrency,
    autoRechargeAllowed: limits.autoRechargeAllowed,
    supportByok: limits.supportByok,
    restrictedVm0Models: limits.restrictedVm0Models,
    videoGenerationAllowed: limits.videoGenerationAllowed,
    audioLifetimeLimit: limits.audioLifetimeLimit,
    audioDailyRateLimit: limits.audioDailyRateLimit,
    audioDailyDurationSeconds: limits.audioDailyDurationSeconds,
    stripeSubscriptionId: args.stripeSubscriptionId ?? null,
    stripePriceId: args.stripePriceId ?? null,
    currentPeriodStart: args.currentPeriodStart ?? null,
    currentPeriodEnd: args.currentPeriodEnd ?? null,
    cancelAt: args.cancelAt ?? null,
    expiresAt: args.expiresAt ?? null,
    sourceMetadata: args.sourceMetadata ?? {},
    updatedAt,
  };

  await tx
    .insert(orgPlanEntitlements)
    .values(values)
    .onConflictDoUpdate({
      target: orgPlanEntitlements.orgId,
      set: {
        planKey: values.planKey,
        planRank: values.planRank,
        source: values.source,
        status: values.status,
        baseConcurrencyLimit: values.baseConcurrencyLimit,
        canBuyConcurrency: values.canBuyConcurrency,
        autoRechargeAllowed: values.autoRechargeAllowed,
        supportByok: values.supportByok,
        restrictedVm0Models: values.restrictedVm0Models,
        videoGenerationAllowed: values.videoGenerationAllowed,
        audioLifetimeLimit: values.audioLifetimeLimit,
        audioDailyRateLimit: values.audioDailyRateLimit,
        audioDailyDurationSeconds: values.audioDailyDurationSeconds,
        stripeSubscriptionId: values.stripeSubscriptionId,
        stripeProductId: null,
        stripePriceId: values.stripePriceId,
        currentPeriodStart: values.currentPeriodStart,
        currentPeriodEnd: values.currentPeriodEnd,
        cancelAt: values.cancelAt,
        expiresAt: values.expiresAt,
        metadataHash: null,
        sourceMetadata: values.sourceMetadata,
        updatedAt,
      },
    });
}

export async function orgPlanEntitlementOrgIdForStripeSubscription(
  tx: WriteTx,
  stripeSubscriptionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ orgId: orgPlanEntitlements.orgId })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return row?.orgId ?? null;
}
