/**
 * Test fixture for the current org plan entitlement snapshot.
 *
 * The snapshot has no public API for constructing deliberately divergent
 * capabilities, so integration tests use this narrow boundary to verify those
 * reads and persisted webhook side effects.
 */
import { orgPlanEntitlements } from "@vm0/db/schema/org-plan-entitlement";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
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
  readonly canBuyCredits: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
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

export async function upsertOrgPlanEntitlementFixture(values: {
  readonly orgId: string;
  readonly status?: string;
  readonly baseConcurrencyLimit?: number;
  readonly canBuyConcurrency?: boolean;
  readonly canBuyCredits?: boolean;
  readonly autoRechargeAllowed?: boolean;
  readonly supportByok?: boolean;
  readonly restrictedVm0Models?: boolean;
  readonly workflowWebhookAutomationAllowed?: boolean;
}): Promise<void> {
  const row = {
    orgId: values.orgId,
    planKey: "test-fixture",
    planRank: 0,
    source: "test_fixture",
    status: values.status ?? "active",
    baseConcurrencyLimit: values.baseConcurrencyLimit ?? 0,
    canBuyConcurrency: values.canBuyConcurrency,
    canBuyCredits: values.canBuyCredits,
    autoRechargeAllowed: values.autoRechargeAllowed,
    supportByok: values.supportByok,
    restrictedVm0Models: values.restrictedVm0Models,
    workflowWebhookTriggerAllowed: values.workflowWebhookAutomationAllowed,
  };
  await createStore()
    .set(writeDb$)
    .insert(orgPlanEntitlements)
    .values(row)
    .onConflictDoUpdate({
      target: orgPlanEntitlements.orgId,
      set: {
        planKey: row.planKey,
        planRank: row.planRank,
        source: row.source,
        status: row.status,
        baseConcurrencyLimit: row.baseConcurrencyLimit,
        ...(row.canBuyConcurrency === undefined
          ? {}
          : { canBuyConcurrency: row.canBuyConcurrency }),
        ...(row.canBuyCredits === undefined
          ? {}
          : { canBuyCredits: row.canBuyCredits }),
        ...(row.autoRechargeAllowed === undefined
          ? {}
          : { autoRechargeAllowed: row.autoRechargeAllowed }),
        ...(row.supportByok === undefined
          ? {}
          : { supportByok: row.supportByok }),
        ...(row.restrictedVm0Models === undefined
          ? {}
          : { restrictedVm0Models: row.restrictedVm0Models }),
        ...(row.workflowWebhookTriggerAllowed === undefined
          ? {}
          : {
              workflowWebhookTriggerAllowed: row.workflowWebhookTriggerAllowed,
            }),
      },
    });
}

/**
 * Simulates an API instance from before migration 0639. It can create legacy
 * org metadata but does not explicitly create a plan entitlement snapshot.
 */
export async function insertOrgMetadataAsLegacyWriterFixture(values: {
  readonly orgId: string;
  readonly tier: string;
  readonly credits: number;
}): Promise<void> {
  await createStore().set(writeDb$).insert(orgMetadata).values(values);
}

/**
 * Simulates an API instance from before migration 0639. Its entitlement
 * upsert changes plan_key without writing the newly-added capability column.
 */
export async function updateOrgPlanKeyAsLegacyWriterFixture(values: {
  readonly orgId: string;
  readonly planKey: string;
}): Promise<void> {
  await createStore()
    .set(writeDb$)
    .update(orgPlanEntitlements)
    .set({ planKey: values.planKey })
    .where(eq(orgPlanEntitlements.orgId, values.orgId));
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
      canBuyCredits: orgPlanEntitlements.canBuyCredits,
      autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
      supportByok: orgPlanEntitlements.supportByok,
      restrictedVm0Models: orgPlanEntitlements.restrictedVm0Models,
      videoGenerationAllowed: orgPlanEntitlements.videoGenerationAllowed,
      workflowWebhookAutomationAllowed:
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
