import { cronAggregateInsightsContract } from "@vm0/api-contracts/contracts/cron";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageFixture$,
  insertUsageEvent$,
  seedRun$,
  seedUsageFixture$,
  type UsageFixture,
} from "./helpers/zero-usage";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const FIXED_NOW_ISO = "2999-01-02T12:00:00.000Z";
const TODAY = "2999-01-02";

interface InsightData {
  readonly agents: {
    readonly agentName: string;
    readonly runs: number;
    readonly credits: number;
  }[];
  readonly creditsUsed: number;
  readonly creditBalance: number;
  readonly teamUsage: {
    readonly name: string;
    readonly credits: number;
    readonly userId: string;
  }[];
  readonly services: {
    readonly domain: string;
    readonly calls: number;
    readonly agentNames: string[];
  }[];
  readonly axiomDegraded?: boolean;
}

function apiClient() {
  return setupApp({ context })(cronAggregateInsightsContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

async function cleanupFixture(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(insightsDaily)
    .where(
      and(
        eq(insightsDaily.orgId, fixture.orgId),
        eq(insightsDaily.userId, fixture.userId),
      ),
    );
  await store.set(deleteUsageFixture$, fixture, context.signal);
}

async function setCreditBalance(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .update(orgMetadata)
    .set({ credits: 100_000 })
    .where(eq(orgMetadata.orgId, fixture.orgId));
}

async function seedUserName(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userCache).values({
    userId: fixture.userId,
    email: "test@example.com",
    name: "Test User",
    cachedAt: new Date(FIXED_NOW_ISO),
  });
}

async function findInsights(
  fixture: UsageFixture,
): Promise<InsightData | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ data: insightsDaily.data })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.orgId, fixture.orgId),
        eq(insightsDaily.userId, fixture.userId),
        eq(insightsDaily.date, TODAY),
      ),
    )
    .limit(1);
  return (row?.data as InsightData | undefined) ?? null;
}

describe("GET /api/cron/aggregate-insights", () => {
  const track = createFixtureTracker<UsageFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
    context.mocks.axiom.query.mockResolvedValue([]);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().aggregate({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("returns skipped when there is no current activity", async () => {
    const response = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ users: 0, skipped: true });
  });

  it("aggregates completed runs, processed credits, and network services", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await setCreditBalance(fixture);
    await seedUserName(fixture);
    const completedAt = new Date("2999-01-02T11:55:00.000Z");
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: completedAt,
        startedAt: completedAt,
        completedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        creditsCharged: 500,
        status: "processed",
        processedAt: completedAt,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: completedAt.toISOString(),
        runId,
        host: "api.slack.com",
        firewall_name: "slack",
        firewall_permission: "send_message",
        action: "ALLOW",
      },
    ]);

    const response = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      users: 1,
      windows: 1,
      networkRows: 1,
    });
    const data = await findInsights(fixture);
    expect(data).toMatchObject({
      creditsUsed: 500,
      creditBalance: 100_000,
    });
    expect(data?.agents).toHaveLength(1);
    expect(data?.agents[0]).toMatchObject({ runs: 1, credits: 500 });
    expect(data?.teamUsage).toMatchObject([
      { name: "Test User", credits: 500, userId: fixture.userId },
    ]);
    expect(data?.services).toMatchObject([{ domain: "slack", calls: 1 }]);
  });

  it("marks insights degraded when Axiom query fails", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(fixture);
    const completedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: completedAt,
        startedAt: completedAt,
        completedAt,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockRejectedValue(new Error("axiom down"));

    const response = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toMatchObject({ users: 1, networkRows: 0 });
    const data = await findInsights(fixture);
    expect(data?.axiomDegraded).toBeTruthy();
  });
});
