import { command } from "ccstate";

import { nowDate } from "../../../../lib/time";
import {
  deleteUsageFixture$,
  seedExistingUsageInsights$,
  seedUsageFixture$,
  type UsageFixture,
} from "./zero-usage";

export interface InsightsFixture {
  readonly orgId: string;
  readonly userId: string;
}

function toUsageFixture(fixture: InsightsFixture): UsageFixture {
  return {
    orgId: fixture.orgId,
    userId: fixture.userId,
    userIds: [fixture.userId],
  };
}

export const seedInsightsFixture$ = command(
  async (
    { set },
    _input: void,
    signal: AbortSignal,
  ): Promise<InsightsFixture> => {
    const fixture = await set(seedUsageFixture$, {}, signal);
    return { orgId: fixture.orgId, userId: fixture.userId };
  },
);

export const deleteInsightsForFixture$ = command(
  async (
    { set },
    fixture: InsightsFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(deleteUsageFixture$, toUsageFixture(fixture), signal);
  },
);

export const seedInsightsDaily$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly date: string;
      readonly data: Record<string, unknown>;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      seedExistingUsageInsights$,
      {
        fixture: toUsageFixture({ orgId: args.orgId, userId: args.userId }),
        date: args.date,
        updatedAt: nowDate(),
        data: args.data,
      },
      signal,
    );
  },
);
