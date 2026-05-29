import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq, sql } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

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

export const seedBillingStatusOrg$ = command(
  async (
    { set },
    values: BillingStatusSeedValues,
    signal: AbortSignal,
  ): Promise<BillingStatusFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    const credits = values.credits ?? 0;
    const sub = values.subscription;

    await writeDb.insert(orgMetadata).values({
      orgId,
      credits,
      tier: sub?.tier ?? "free",
      stripeCustomerId: sub?.stripeCustomerId ?? null,
      stripeSubscriptionId: sub?.stripeSubscriptionId ?? null,
      subscriptionStatus: sub?.status ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    });
    signal.throwIfAborted();

    if (values.extraGrantedCredits) {
      await writeDb
        .update(orgMetadata)
        .set({
          credits: sql`${orgMetadata.credits} + ${values.extraGrantedCredits}`,
        })
        .where(eq(orgMetadata.orgId, orgId));
      signal.throwIfAborted();
    }

    const expiresRecordIds: string[] = [];
    for (const record of values.expiresRecords ?? []) {
      const [row] = await writeDb
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
