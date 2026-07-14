/**
 * Test fixture for the current org plan entitlement snapshot.
 *
 * The snapshot has no public read API, so webhook integration tests use this
 * narrow boundary to verify the persisted side effect.
 */
import { orgPlanEntitlements } from "@vm0/db/schema/org-plan-entitlement";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

interface OrgPlanEntitlementFixtureState {
  readonly orgId: string;
  readonly planKey: string;
  readonly planRank: number;
  readonly source: string;
  readonly status: string;
  readonly baseConcurrencyLimit: number;
  readonly canBuyConcurrency: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookTriggerAllowed: boolean;
  readonly audioLifetimeLimit: number | null;
  readonly audioDailyRateLimit: number;
  readonly audioDailyDurationSeconds: number;
  readonly stripeSubscriptionId: string | null;
  readonly stripePriceId: string | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAt: string | null;
  readonly expiresAt: string | null;
}

export async function readOrgPlanEntitlementFixture(
  orgId: string,
): Promise<OrgPlanEntitlementFixtureState | null> {
  const [row] = await createStore()
    .set(writeDb$)
    .select({
      orgId: orgPlanEntitlements.orgId,
      planKey: orgPlanEntitlements.planKey,
      planRank: orgPlanEntitlements.planRank,
      source: orgPlanEntitlements.source,
      status: orgPlanEntitlements.status,
      baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
      canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
      autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
      supportByok: orgPlanEntitlements.supportByok,
      restrictedVm0Models: orgPlanEntitlements.restrictedVm0Models,
      videoGenerationAllowed: orgPlanEntitlements.videoGenerationAllowed,
      workflowWebhookTriggerAllowed:
        orgPlanEntitlements.workflowWebhookTriggerAllowed,
      audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
      audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
      audioDailyDurationSeconds: orgPlanEntitlements.audioDailyDurationSeconds,
      stripeSubscriptionId: orgPlanEntitlements.stripeSubscriptionId,
      stripePriceId: orgPlanEntitlements.stripePriceId,
      currentPeriodStart: orgPlanEntitlements.currentPeriodStart,
      currentPeriodEnd: orgPlanEntitlements.currentPeriodEnd,
      cancelAt: orgPlanEntitlements.cancelAt,
      expiresAt: orgPlanEntitlements.expiresAt,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    ...row,
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAt: row.cancelAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

export async function deleteOrgPlanEntitlementFixture(
  orgId: string,
): Promise<void> {
  await createStore()
    .set(writeDb$)
    .delete(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId));
}
