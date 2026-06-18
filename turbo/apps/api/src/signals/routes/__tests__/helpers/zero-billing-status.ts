import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgConcurrencyEntitlements } from "@vm0/db/schema/org-concurrency-entitlement";
import { orgConcurrencySubscriptions } from "@vm0/db/schema/org-concurrency-subscription";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq, sql } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { nowDate } from "../../../external/time";

type WriteDb = ReturnType<typeof writeDb$.write>;
type OrgMetadataInsert = typeof orgMetadata.$inferInsert;

export interface BillingStatusFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly expiresRecordIds: readonly string[];
}

interface SubscriptionSeed {
  readonly tier: string;
  readonly status: string;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd?: boolean;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly pendingSubscriptionScheduleId?: string;
  readonly pendingSubscriptionTargetTier?: string;
  readonly pendingSubscriptionChangeAt?: Date;
}

interface ExpiresRecordSeed {
  readonly source: string;
  readonly amount: number;
  readonly remaining?: number;
  readonly expiresAt: Date;
  readonly stripeInvoiceId?: string;
}

interface ConcurrencyEntitlementSeed {
  readonly slots: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly subscriptionStatus?: string;
  readonly cancelAtPeriodEnd?: boolean;
  readonly stripeSubscriptionId?: string;
  readonly stripeInvoiceId?: string;
  readonly stripeInvoiceLineId?: string;
  readonly stripePriceId?: string;
}

interface BillingStatusSeedValues {
  readonly credits?: number;
  readonly onboardingPaymentPending?: boolean;
  readonly subscription?: SubscriptionSeed;
  readonly expiresRecords?: readonly ExpiresRecordSeed[];
  readonly concurrencyEntitlements?: readonly ConcurrencyEntitlementSeed[];
  readonly extraGrantedCredits?: number;
}

function orgMetadataSeedValues(
  orgId: string,
  values: BillingStatusSeedValues,
): OrgMetadataInsert {
  const sub = values.subscription;
  return {
    orgId,
    credits: values.credits ?? 0,
    onboardingPaymentPending: Boolean(values.onboardingPaymentPending),
    tier: sub?.tier ?? "free",
    stripeCustomerId: sub?.stripeCustomerId ?? null,
    stripeSubscriptionId: sub?.stripeSubscriptionId ?? null,
    subscriptionStatus: sub?.status ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    pendingSubscriptionScheduleId: sub?.pendingSubscriptionScheduleId ?? null,
    pendingSubscriptionTargetTier: sub?.pendingSubscriptionTargetTier ?? null,
    pendingSubscriptionChangeAt: sub?.pendingSubscriptionChangeAt ?? null,
  };
}

async function grantExtraCredits(
  db: WriteDb,
  orgId: string,
  credits: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!credits) {
    return;
  }

  await db
    .update(orgMetadata)
    .set({
      credits: sql`${orgMetadata.credits} + ${credits}`,
    })
    .where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
}

async function insertExpiresRecords(
  db: WriteDb,
  orgId: string,
  records: readonly ExpiresRecordSeed[] | undefined,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const expiresRecordIds: string[] = [];
  for (const record of records ?? []) {
    const [row] = await db
      .insert(creditExpiresRecord)
      .values({
        orgId,
        source: record.source,
        amount: record.amount,
        remaining: record.remaining ?? record.amount,
        expiresAt: record.expiresAt,
        stripeInvoiceId: record.stripeInvoiceId ?? `inv_${randomUUID()}`,
      })
      .returning({ id: creditExpiresRecord.id });
    signal.throwIfAborted();
    if (row) {
      expiresRecordIds.push(row.id);
    }
  }
  return expiresRecordIds;
}

async function insertConcurrencyEntitlements(
  db: WriteDb,
  orgId: string,
  entitlements: readonly ConcurrencyEntitlementSeed[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  const subscriptions = new Map<
    string,
    {
      readonly stripePriceId: string;
      readonly subscriptionStatus: string;
      readonly cancelAtPeriodEnd: boolean;
      slots: number;
      currentPeriodEnd: Date;
    }
  >();
  const currentTime = nowDate();
  for (const entitlement of entitlements ?? []) {
    const stripeSubscriptionId =
      entitlement.stripeSubscriptionId ?? `sub_${randomUUID()}`;
    const stripePriceId = entitlement.stripePriceId ?? `price_${randomUUID()}`;
    await db.insert(orgConcurrencyEntitlements).values({
      orgId,
      slots: entitlement.slots,
      startsAt: entitlement.startsAt,
      expiresAt: entitlement.expiresAt,
      stripeSubscriptionId,
      stripeInvoiceId: entitlement.stripeInvoiceId ?? `inv_${randomUUID()}`,
      stripeInvoiceLineId:
        entitlement.stripeInvoiceLineId ?? `il_${randomUUID()}`,
      stripePriceId,
    });
    if (
      entitlement.startsAt <= currentTime &&
      entitlement.expiresAt > currentTime
    ) {
      const existing = subscriptions.get(stripeSubscriptionId);
      if (existing) {
        existing.slots += entitlement.slots;
        if (entitlement.expiresAt > existing.currentPeriodEnd) {
          existing.currentPeriodEnd = entitlement.expiresAt;
        }
      } else {
        subscriptions.set(stripeSubscriptionId, {
          stripePriceId,
          subscriptionStatus: entitlement.subscriptionStatus ?? "active",
          cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd ?? false,
          slots: entitlement.slots,
          currentPeriodEnd: entitlement.expiresAt,
        });
      }
    }
    signal.throwIfAborted();
  }
  for (const [stripeSubscriptionId, subscription] of subscriptions) {
    await db.insert(orgConcurrencySubscriptions).values({
      orgId,
      stripeSubscriptionId,
      stripePriceId: subscription.stripePriceId,
      slots: subscription.slots,
      subscriptionStatus: subscription.subscriptionStatus,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    });
    signal.throwIfAborted();
  }
}

export const seedBillingStatusOrg$ = command(
  async (
    { set },
    values: BillingStatusSeedValues,
    signal: AbortSignal,
  ): Promise<BillingStatusFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    await writeDb
      .insert(orgMetadata)
      .values(orgMetadataSeedValues(orgId, values));
    signal.throwIfAborted();

    await grantExtraCredits(writeDb, orgId, values.extraGrantedCredits, signal);
    const expiresRecordIds = await insertExpiresRecords(
      writeDb,
      orgId,
      values.expiresRecords,
      signal,
    );
    await insertConcurrencyEntitlements(
      writeDb,
      orgId,
      values.concurrencyEntitlements,
      signal,
    );

    return { orgId, userId, expiresRecordIds };
  },
);

export const deleteBillingStatusOrg$ = command(
  async (
    { set },
    fixture: BillingStatusFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgConcurrencyEntitlements)
      .where(eq(orgConcurrencyEntitlements.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgConcurrencySubscriptions)
      .where(eq(orgConcurrencySubscriptions.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);
