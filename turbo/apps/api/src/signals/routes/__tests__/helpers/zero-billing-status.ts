import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq, sql } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

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

interface BillingStatusSeedValues {
  readonly credits?: number;
  readonly subscription?: SubscriptionSeed;
  readonly expiresRecords?: readonly ExpiresRecordSeed[];
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
      .delete(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);
