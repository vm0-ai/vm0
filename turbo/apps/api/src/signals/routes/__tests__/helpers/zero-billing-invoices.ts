import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface InvoicesOrgFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly stripeCustomerId: string | null;
}

interface InvoicesSeedValues {
  readonly stripeCustomerId?: string | null;
  readonly stripeSubscriptionId?: string | null;
  readonly subscriptionStatus?: string | null;
  readonly tier?: string;
  readonly currentPeriodEnd?: Date | null;
}

export const seedInvoicesOrg$ = command(
  async (
    { set },
    values: InvoicesSeedValues,
    signal: AbortSignal,
  ): Promise<InvoicesOrgFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    const stripeCustomerId = values.stripeCustomerId ?? null;

    await writeDb.insert(orgMetadata).values({
      orgId,
      stripeCustomerId,
      stripeSubscriptionId: values.stripeSubscriptionId ?? null,
      subscriptionStatus: values.subscriptionStatus ?? null,
      ...(values.tier !== undefined ? { tier: values.tier } : {}),
      ...(values.currentPeriodEnd !== undefined
        ? { currentPeriodEnd: values.currentPeriodEnd }
        : {}),
    });
    signal.throwIfAborted();

    return { orgId, userId, stripeCustomerId };
  },
);

export const deleteInvoicesOrg$ = command(
  async (
    { set },
    fixture: InvoicesOrgFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);
