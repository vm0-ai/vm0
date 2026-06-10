import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgPromoRedemption } from "@vm0/db/schema/org-promo-redemption";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface RedeemFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SeedOrgArgs {
  readonly stripeCustomerId?: string;
}

export const seedRedeemOrg$ = command(
  async (
    { set },
    args: SeedOrgArgs,
    signal: AbortSignal,
  ): Promise<RedeemFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);
    await writeDb.insert(orgMetadata).values({
      orgId,
      stripeCustomerId: args.stripeCustomerId ?? null,
    });
    signal.throwIfAborted();
    return { orgId, userId };
  },
);

export const deleteRedeemOrg$ = command(
  async (
    { set },
    fixture: RedeemFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgPromoRedemption)
      .where(eq(orgPromoRedemption.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

interface PromoRow {
  readonly orgId: string;
  readonly campaignKey: string;
  readonly stripeSessionId: string;
}

export const seedOrgPromoRedemption$ = command(
  async ({ set }, args: PromoRow, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(orgPromoRedemption).values(args);
    signal.throwIfAborted();
  },
);

export const findOrgPromoRedemption$ = command(
  async (
    { set },
    args: Pick<PromoRow, "orgId" | "campaignKey">,
  ): Promise<{ stripeSessionId: string } | undefined> => {
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .select({ stripeSessionId: orgPromoRedemption.stripeSessionId })
      .from(orgPromoRedemption)
      .where(
        and(
          eq(orgPromoRedemption.orgId, args.orgId),
          eq(orgPromoRedemption.campaignKey, args.campaignKey),
        ),
      )
      .limit(1);
    return row;
  },
);

interface CreditRow {
  readonly orgId: string;
  readonly source: string;
  readonly stripeInvoiceId: string;
  readonly amount: number;
  readonly expiresAt: Date;
}

export const seedCreditExpiresRecord$ = command(
  async ({ set }, args: CreditRow, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(creditExpiresRecord).values({
      orgId: args.orgId,
      source: args.source,
      stripeInvoiceId: args.stripeInvoiceId,
      amount: args.amount,
      remaining: args.amount,
      expiresAt: args.expiresAt,
    });
    signal.throwIfAborted();
  },
);
