import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { nowDate } from "../../../external/time";

export interface MemberCreditCapFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SeedFixtureValues {
  readonly currentPeriodEnd?: Date | null;
  readonly creditCap?: number | null;
  readonly creditEnabled?: boolean;
}

export const seedMemberCreditCapFixture$ = command(
  async (
    { set },
    values: SeedFixtureValues,
    signal: AbortSignal,
  ): Promise<MemberCreditCapFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    if (values.currentPeriodEnd !== undefined) {
      await writeDb.insert(orgMetadata).values({
        orgId,
        currentPeriodEnd: values.currentPeriodEnd,
      });
      signal.throwIfAborted();
    }

    if (values.creditCap !== undefined || values.creditEnabled !== undefined) {
      await writeDb.insert(orgMembersMetadata).values({
        orgId,
        userId,
        creditCap: values.creditCap ?? null,
        creditEnabled: values.creditEnabled ?? true,
      });
      signal.throwIfAborted();
    }

    return { orgId, userId };
  },
);

export const deleteMemberCreditCapFixture$ = command(
  async (
    { set },
    fixture: MemberCreditCapFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

interface UsageInsert {
  readonly orgId: string;
  readonly userId: string;
  readonly creditsCharged: number;
  readonly processedAt?: Date;
}

export const insertProcessedModelUsage$ = command(
  async ({ set }, args: UsageInsert, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(usageEvent).values({
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider: "claude-sonnet-4-20250514",
      category: "tokens.input",
      quantity: 1,
      creditsCharged: args.creditsCharged,
      status: "processed",
      idempotencyKey: randomUUID(),
      processedAt: args.processedAt ?? nowDate(),
    });
    signal.throwIfAborted();
  },
);

export const insertProcessedConnectorUsage$ = command(
  async ({ set }, args: UsageInsert, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(usageEvent).values({
      orgId: args.orgId,
      userId: args.userId,
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 1,
      creditsCharged: args.creditsCharged,
      status: "processed",
      idempotencyKey: randomUUID(),
      processedAt: args.processedAt ?? nowDate(),
    });
    signal.throwIfAborted();
  },
);
