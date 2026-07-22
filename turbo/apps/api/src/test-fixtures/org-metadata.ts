/**
 * In-process test fixture for `org_metadata` tier and credit balance.
 *
 * The tier/credit combinations the generation tests exercise cannot be
 * constructed through product APIs: the Stripe webhook path only produces
 * "pro"/"team" orgs with fixed subscription credit grants, "limited-free-1"
 * is only set by the Clerk org-creation bootstrap (which also provisions a
 * default agent/compose), and the legacy "free" tier — still present in
 * production data and load-bearing for voice-io quota limits — has no
 * creation path at all. Exact credit balances (e.g. 0 or 1000) are equally
 * unreachable because product grants come in fixed subscription amounts.
 * The legacy onboarding-payment-pending state also has no write path after
 * removing the retired onboarding setup endpoint, but billing must continue
 * reading existing rows. This module is the narrow test-boundary exception
 * for those persisted states.
 */
import { orgTierSchema } from "@vm0/api-contracts/contracts/orgs";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";
import { upsertOrgPlanEntitlement } from "../signals/services/org-plan-entitlements.service";

export async function upsertOrgMetadataFixture(values: {
  readonly orgId: string;
  readonly tier: string;
  readonly credits: number;
}): Promise<void> {
  const tier = orgTierSchema.parse(values.tier);
  await createStore()
    .set(writeDb$)
    .transaction(async (tx) => {
      await tx
        .insert(orgMetadata)
        .values(values)
        .onConflictDoUpdate({
          target: orgMetadata.orgId,
          set: {
            tier: values.tier,
            credits: values.credits,
            updatedAt: sql`now()`,
          },
        });
      await upsertOrgPlanEntitlement(tx, {
        orgId: values.orgId,
        tier,
        source: "org_metadata_migration",
      });
    });
}

export async function expireAtomGrantFixture(values: {
  readonly orgId: string;
  readonly expiredAt: Date;
}): Promise<void> {
  const db = createStore().set(writeDb$);
  await db
    .update(orgMetadata)
    .set({
      currentPeriodEnd: values.expiredAt,
      updatedAt: values.expiredAt,
    })
    .where(eq(orgMetadata.orgId, values.orgId));
  await db
    .update(creditExpiresRecord)
    .set({ expiresAt: values.expiredAt })
    .where(eq(creditExpiresRecord.orgId, values.orgId));
}

export async function setOnboardingPaymentPendingFixture(values: {
  readonly orgId: string;
  readonly onboardingPaymentPending: boolean;
}): Promise<void> {
  await createStore()
    .set(writeDb$)
    .update(orgMetadata)
    .set({
      onboardingPaymentPending: values.onboardingPaymentPending,
      updatedAt: sql`now()`,
    })
    .where(eq(orgMetadata.orgId, values.orgId));
}
