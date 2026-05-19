import { cronAggregateInsightsContract } from "@vm0/api-contracts/contracts/cron";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
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
    readonly agentId: string | null;
    readonly runs: number;
    readonly credits: number;
  }[];
  readonly creditsUsed: number;
  readonly creditBalance: number;
  readonly teamUsage: {
    readonly userId: string;
    readonly name: string;
    readonly credits: number;
    readonly agentNames: string[];
    readonly agentCredits: Record<string, number>;
  }[];
  readonly services: {
    readonly domain: string;
    readonly calls: number;
    readonly agentNames: string[];
  }[];
  readonly permissions: {
    readonly label: string;
    readonly connectorType: string;
    readonly allowed: number;
    readonly denied: number;
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

async function rawCronRequest(
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/cron/aggregate-insights", {
    method: "GET",
    headers,
  });
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

async function seedUserName(
  fixture: UsageFixture,
  email = "test@example.com",
  name: string | null = "Test User",
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userCache).values({
    userId: fixture.userId,
    email,
    name,
    cachedAt: new Date(FIXED_NOW_ISO),
  });
}

async function seedExistingInsights(
  fixture: UsageFixture,
  updatedAt: Date,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(insightsDaily).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    date: TODAY,
    updatedAt,
    data: {
      agents: [],
      creditsUsed: 0,
      creditBalance: 0,
      teamUsage: [],
      topTask: null,
      services: [],
      permissions: [],
    },
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

  it("rejects requests with a missing authorization header", async () => {
    const response = await rawCronRequest();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toStrictEqual({
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

  it("counts processed credits for an earlier run on the current aggregation day", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(fixture);
    const previousDay = new Date("2999-01-01T10:00:00.000Z");
    const processedAt = new Date("2999-01-02T11:55:00.000Z");
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: previousDay,
        startedAt: previousDay,
        completedAt: new Date("2999-01-01T10:01:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        creditsCharged: 600,
        status: "processed",
        processedAt,
      },
      context.signal,
    );

    const response = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      users: 1,
      windows: 1,
      networkRows: 0,
    });
    const data = await findInsights(fixture);
    expect(data?.creditsUsed).toBe(600);
    expect(data?.agents).toMatchObject([{ runs: 0, credits: 600 }]);
  });

  it("counts runs by completedAt when the run was created earlier", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const completedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: new Date("2999-01-01T10:00:00.000Z"),
        startedAt: new Date("2999-01-01T10:00:00.000Z"),
        completedAt,
      },
      context.signal,
    );

    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);

    const data = await findInsights(fixture);
    expect(data?.agents).toMatchObject([{ runs: 1, credits: 0 }]);
  });

  it("includes runless usage events as other usage", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(fixture);
    const processedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: null,
        creditsCharged: 333,
        status: "processed",
        processedAt,
      },
      context.signal,
    );

    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);

    const data = await findInsights(fixture);
    expect(data?.creditsUsed).toBe(333);
    expect(data?.agents).toStrictEqual([
      { agentId: null, agentName: "Other usage", runs: 0, credits: 333 },
    ]);
    expect(data?.teamUsage).toHaveLength(1);
    expect(data?.teamUsage[0]).toMatchObject({
      userId: fixture.userId,
      credits: 333,
      agentNames: ["Other usage"],
      agentCredits: { "Other usage": 333 },
    });
  });

  it("reprocesses activity at the previous aggregation watermark", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(fixture);
    const processedAt = new Date("2999-01-02T11:55:00.000Z");
    await seedExistingInsights(fixture, processedAt);
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: null,
        creditsCharged: 444,
        status: "processed",
        processedAt,
      },
      context.signal,
    );

    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);

    const data = await findInsights(fixture);
    expect(data?.creditsUsed).toBe(444);
  });

  it("keeps agents with the same display name separate", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(fixture);
    const completedAt = new Date("2999-01-02T11:55:00.000Z");
    const firstRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Shared display",
        createdAt: completedAt,
        startedAt: completedAt,
        completedAt,
      },
      context.signal,
    );
    const secondRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Shared display",
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
        runId: firstRun.runId,
        creditsCharged: 100,
        status: "processed",
        processedAt: completedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: secondRun.runId,
        creditsCharged: 200,
        status: "processed",
        processedAt: completedAt,
      },
      context.signal,
    );

    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);

    const data = await findInsights(fixture);
    expect(data?.agents).toHaveLength(2);
    expect(
      data?.agents.map((agent) => {
        return agent.agentName;
      }),
    ).toStrictEqual(["Shared display", "Shared display"]);
    expect(
      new Set(
        data?.agents.map((agent) => {
          return agent.agentId;
        }),
      ).size,
    ).toBe(2);
    expect(
      data?.agents.map((agent) => {
        return agent.runs;
      }),
    ).toStrictEqual([1, 1]);
    expect(
      data?.agents
        .map((agent) => {
          return agent.credits;
        })
        .sort((a, b) => {
          return a - b;
        }),
    ).toStrictEqual([100, 200]);
  });

  it("records denied requests with empty firewall permission", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
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
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: completedAt.toISOString(),
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "",
        action: "DENY",
      },
      {
        _time: completedAt.toISOString(),
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "",
        action: "DENY",
      },
      {
        _time: completedAt.toISOString(),
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "repo-read",
        action: "ALLOW",
      },
    ]);

    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);

    const data = await findInsights(fixture);
    const githubDeny = data?.permissions.find((permission) => {
      return permission.label === "github" && permission.denied > 0;
    });
    expect(githubDeny).toMatchObject({
      connectorType: "github",
      denied: 2,
    });
    const repoRead = data?.permissions.find((permission) => {
      return permission.label.includes("repo-read");
    });
    expect(repoRead).toMatchObject({
      connectorType: "github",
      allowed: 1,
    });
  });

  it("attributes current-day network logs for older runs by runId", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(fixture);
    const previousDay = new Date("2999-01-01T10:00:00.000Z");
    const processedAt = new Date("2999-01-02T11:55:00.000Z");
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: previousDay,
        startedAt: previousDay,
        completedAt: new Date("2999-01-01T10:01:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        creditsCharged: 25,
        status: "processed",
        processedAt,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: processedAt.toISOString(),
        runId,
        host: "api.slack.com",
        firewall_name: "slack",
        firewall_permission: "send_message",
        action: "ALLOW",
      },
    ]);

    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);

    const data = await findInsights(fixture);
    expect(data?.creditsUsed).toBe(25);
    expect(data?.agents).toMatchObject([{ runs: 0, credits: 25 }]);
    expect(data?.services).toStrictEqual([
      { domain: "slack", calls: 1, agentNames: [expect.any(String)] },
    ]);
  });

  it("uses cached user names and falls back to email prefix when the name is null", async () => {
    const aliceFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const bobFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(aliceFixture, "alice@example.com", "Alice");
    await seedUserName(bobFixture, "bob@example.com", null);
    const processedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      insertUsageEvent$,
      {
        orgId: aliceFixture.orgId,
        userId: aliceFixture.userId,
        runId: null,
        creditsCharged: 200,
        status: "processed",
        processedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: bobFixture.orgId,
        userId: bobFixture.userId,
        runId: null,
        creditsCharged: 150,
        status: "processed",
        processedAt,
      },
      context.signal,
    );

    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);

    const aliceData = await findInsights(aliceFixture);
    const bobData = await findInsights(bobFixture);
    expect(aliceData?.teamUsage).toMatchObject([
      { userId: aliceFixture.userId, name: "Alice", credits: 200 },
    ]);
    expect(bobData?.teamUsage).toMatchObject([
      { userId: bobFixture.userId, name: "bob", credits: 150 },
    ]);
  });

  it("is idempotent on rerun", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
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

    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);

    const data = await findInsights(fixture);
    expect(data?.agents).toMatchObject([{ runs: 1 }]);
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
