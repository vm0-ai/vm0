import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface InsightsFixture {
  readonly orgId: string;
  readonly userId: string;
}

export const seedInsightsFixture$ = command(
  (_, _input: void, _signal: AbortSignal): Promise<InsightsFixture> => {
    return Promise.resolve({
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    });
  },
);

export const deleteInsightsForFixture$ = command(
  async (
    { set },
    fixture: InsightsFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(insightsDaily)
      .where(
        and(
          eq(insightsDaily.orgId, fixture.orgId),
          eq(insightsDaily.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

export const seedInsightsDaily$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      date: string;
      data: Record<string, unknown>;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .insert(insightsDaily)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        date: args.date,
        data: args.data,
      })
      .onConflictDoUpdate({
        target: [insightsDaily.orgId, insightsDaily.userId, insightsDaily.date],
        set: { data: args.data },
      });
    signal.throwIfAborted();
  },
);
