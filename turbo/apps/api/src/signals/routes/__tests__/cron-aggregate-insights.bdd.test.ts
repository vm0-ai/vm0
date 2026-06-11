import { randomUUID } from "node:crypto";

import { cronAggregateInsightsContract } from "@vm0/api-contracts/contracts/cron";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
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

// BDD migration of the legacy
// `cron-aggregate-insights.test.ts`. The 15 legacy
// `it()`s collapse into 4 BDD `it()`s:
// (1) auth + empty chain (401 wrong secret + 401 no
// auth header + 200 returns skipped when no activity),
// (2) aggregation chain (200 aggregates completed runs +
// processed credits + network services + 200 counts
// processed credits for earlier run on current day +
// 200 counts runs by completedAt when created earlier +
// 200 includes runless usage as Other usage),
// (3) membership + reprocessing chain (200 excludes
// removed org members + 200 reprocesses at previous
// watermark + 200 keeps agents with same display name
// separate + 200 records denied requests with empty
// firewall permission + 200 attributes current-day
// network logs to older runs by runId + 200 uses cached
// user names with email-prefix fallback),
// (4) idempotency + degraded chain (200 idempotent on
// rerun + 200 marks insights degraded when Axiom query
// fails).

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
  await db.delete(insightsDaily).where(eq(insightsDaily.orgId, fixture.orgId));
  await db
    .delete(orgMembersCache)
    .where(eq(orgMembersCache.orgId, fixture.orgId));
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
  fixture: Pick<UsageFixture, "userId">,
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

async function seedCachedOrgMember(
  orgId: string,
  userId: string,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(orgMembersCache).values({
    orgId,
    userId,
    role: "member",
    cachedAt: new Date(FIXED_NOW_ISO),
  });
}

function mockCurrentOrgMembers(
  orgId: string,
  userIds: readonly string[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (args: unknown) => {
      const input = args as {
        readonly organizationId?: string;
        readonly limit?: number;
        readonly offset?: number;
      };
      const members = input.organizationId === orgId ? userIds : [];
      const offset = input.offset ?? 0;
      const limit = input.limit ?? members.length;
      return Promise.resolve({
        data: members.slice(offset, offset + limit).map((userId) => {
          return { publicUserData: { userId } };
        }),
      });
    },
  );
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

const track = createFixtureTracker<UsageFixture>(cleanupFixture);

describe("BDD GET /api/cron/aggregate-insights — auth + empty chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
    context.mocks.axiom.query.mockResolvedValue([]);
  });

  afterEach(() => {
    clearMockedEnv();
    clearMockNow();
  });

  it("gwt-wt-wt: 401 wrong secret → 401 no auth header → 200 returns skipped when no activity", async () => {
    // Given: a request with the wrong cron secret.

    // When + Then: 401 — Invalid cron secret.
    const wrongSecretResponse = await accept(
      apiClient().aggregate({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(wrongSecretResponse.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    // Given: a request with no authorization header.

    // When + Then: 401 — Invalid cron secret.
    const noAuthResponse = await rawCronRequest();
    const noAuthBody = await noAuthResponse.json();
    expect(noAuthResponse.status).toBe(401);
    expect(noAuthBody).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    // Given: a request with a valid cron secret + no
    // activity in the window.

    // When + Then: 200 — users=0 + skipped=true.
    const skippedResponse = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );
    expect(skippedResponse.body).toStrictEqual({ users: 0, skipped: true });
  });
});

describe("BDD GET /api/cron/aggregate-insights — aggregation chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
    context.mocks.axiom.query.mockResolvedValue([]);
  });

  afterEach(() => {
    clearMockedEnv();
    clearMockNow();
  });

  it("gwt-wt-wt: 200 aggregates completed runs + processed credits + network services → 200 counts processed credits for earlier run → 200 counts runs by completedAt → 200 includes runless usage as Other usage", async () => {
    // Given: a fixture with 100_000 credits + a user
    // name + 1 completed run + 1 processed credit
    // event + 1 Axiom network log (slack
    // send_message ALLOW).

    // When + Then: 200 — users=1 + windows=1 +
    // networkRows=1 + creditsUsed=500 +
    // creditBalance=100_000 + 1 agent with runs=1 +
    // credits=500 + 1 teamUsage row + 1 service
    // domain=slack calls=1.
    const fullFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await setCreditBalance(fullFixture);
    await seedUserName(fullFixture);
    const fullCompletedAt = new Date("2999-01-02T11:55:00.000Z");
    const { runId: fullRunId } = await store.set(
      seedRun$,
      {
        orgId: fullFixture.orgId,
        userId: fullFixture.userId,
        createdAt: fullCompletedAt,
        startedAt: fullCompletedAt,
        completedAt: fullCompletedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fullFixture.orgId,
        userId: fullFixture.userId,
        runId: fullRunId,
        creditsCharged: 500,
        status: "processed",
        processedAt: fullCompletedAt,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: fullCompletedAt.toISOString(),
        runId: fullRunId,
        host: "api.slack.com",
        firewall_name: "slack",
        firewall_permission: "send_message",
        action: "ALLOW",
      },
    ]);
    const fullResponse = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );
    expect(fullResponse.body).toStrictEqual({
      users: 1,
      windows: 1,
      networkRows: 1,
    });
    const fullData = await findInsights(fullFixture);
    expect(fullData).toMatchObject({
      creditsUsed: 500,
      creditBalance: 100_000,
    });
    expect(fullData?.agents).toHaveLength(1);
    expect(fullData?.agents[0]).toMatchObject({ runs: 1, credits: 500 });
    expect(fullData?.teamUsage).toMatchObject([
      { name: "Test User", credits: 500, userId: fullFixture.userId },
    ]);
    expect(fullData?.services).toMatchObject([{ domain: "slack", calls: 1 }]);

    // Given: a fixture + a user name + a previous-day
    // run + a same-day processed credit event.

    // When + Then: 200 — users=1 + windows=1 +
    // networkRows=0 + creditsUsed=600 + 1 agent with
    // runs=0 + credits=600.
    const priorDayFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(priorDayFixture);
    const previousDay = new Date("2999-01-01T10:00:00.000Z");
    const processedAt = new Date("2999-01-02T11:55:00.000Z");
    const { runId: priorDayRunId } = await store.set(
      seedRun$,
      {
        orgId: priorDayFixture.orgId,
        userId: priorDayFixture.userId,
        createdAt: previousDay,
        startedAt: previousDay,
        completedAt: new Date("2999-01-01T10:01:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: priorDayFixture.orgId,
        userId: priorDayFixture.userId,
        runId: priorDayRunId,
        creditsCharged: 600,
        status: "processed",
        processedAt,
      },
      context.signal,
    );
    const priorDayResponse = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );
    expect(priorDayResponse.body).toMatchObject({ windows: 1 });
    const priorDayData = await findInsights(priorDayFixture);
    expect(priorDayData?.creditsUsed).toBe(600);
    expect(priorDayData?.agents).toMatchObject([{ runs: 0, credits: 600 }]);

    // Given: a fixture + a run created yesterday that
    // completed today.

    // When + Then: 200 — 1 agent with runs=1 +
    // credits=0.
    const countedByCompletedAtFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const countedByCompletedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      seedRun$,
      {
        orgId: countedByCompletedAtFixture.orgId,
        userId: countedByCompletedAtFixture.userId,
        createdAt: new Date("2999-01-01T10:00:00.000Z"),
        startedAt: new Date("2999-01-01T10:00:00.000Z"),
        completedAt: countedByCompletedAt,
      },
      context.signal,
    );
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    const countedData = await findInsights(countedByCompletedAtFixture);
    expect(countedData?.agents).toMatchObject([{ runs: 1, credits: 0 }]);

    // Given: a fixture + a user name + a runless
    // processed credit event for 333 credits.

    // When + Then: 200 — creditsUsed=333 + 1 agent
    // with agentName="Other usage" + runs=0 +
    // credits=333 + 1 teamUsage row with the same
    // breakdown.
    const runlessFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(runlessFixture);
    const runlessProcessedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      insertUsageEvent$,
      {
        orgId: runlessFixture.orgId,
        userId: runlessFixture.userId,
        runId: null,
        creditsCharged: 333,
        status: "processed",
        processedAt: runlessProcessedAt,
      },
      context.signal,
    );
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    const runlessData = await findInsights(runlessFixture);
    expect(runlessData?.creditsUsed).toBe(333);
    expect(runlessData?.agents).toStrictEqual([
      { agentId: null, agentName: "Other usage", runs: 0, credits: 333 },
    ]);
    expect(runlessData?.teamUsage).toHaveLength(1);
    expect(runlessData?.teamUsage[0]).toMatchObject({
      userId: runlessFixture.userId,
      credits: 333,
      agentNames: ["Other usage"],
      agentCredits: { "Other usage": 333 },
    });
  });
});

describe("BDD GET /api/cron/aggregate-insights — membership + reprocessing chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
    context.mocks.axiom.query.mockResolvedValue([]);
  });

  afterEach(() => {
    clearMockedEnv();
    clearMockNow();
  });

  it("gwt-wt-wt: 200 excludes removed org members → 200 reprocesses at previous watermark → 200 keeps agents with same display name separate → 200 records denied requests → 200 attributes current-day network logs to older runs → 200 uses cached user names with email-prefix fallback", async () => {
    // Given: a fixture with 1 active member + 1
    // cached non-member + 1 Clerk-current removed user
    // + 200 credits for the active member + 900 credits
    // for the removed user.

    // When + Then: 200 — creditsUsed=200 + teamUsage
    // contains only the Active Member row.
    const membersFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const removedUserId = `user_${randomUUID()}`;
    const cachedOtherUserId = `user_${randomUUID()}`;
    await seedCachedOrgMember(membersFixture.orgId, cachedOtherUserId);
    mockCurrentOrgMembers(membersFixture.orgId, [
      membersFixture.userId,
      cachedOtherUserId,
    ]);
    await seedUserName(membersFixture, "active@example.com", "Active Member");
    await seedUserName(
      { userId: removedUserId },
      "removed@example.com",
      "Removed Member",
    );
    const membersProcessedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      insertUsageEvent$,
      {
        orgId: membersFixture.orgId,
        userId: membersFixture.userId,
        runId: null,
        creditsCharged: 200,
        status: "processed",
        processedAt: membersProcessedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: membersFixture.orgId,
        userId: removedUserId,
        runId: null,
        creditsCharged: 900,
        status: "processed",
        processedAt: membersProcessedAt,
      },
      context.signal,
    );
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    const membersData = await findInsights(membersFixture);
    expect(membersData?.creditsUsed).toBe(200);
    expect(membersData?.teamUsage).toStrictEqual([
      {
        userId: membersFixture.userId,
        name: "Active Member",
        credits: 200,
        agentNames: ["Other usage"],
        agentCredits: { "Other usage": 200 },
      },
    ]);

    // Given: a fixture with a user name + pre-existing
    // insights (updatedAt=processedAt) + a new
    // processed credit event.

    // When + Then: 200 — creditsUsed=444.
    const watermarkFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(watermarkFixture);
    const watermarkProcessedAt = new Date("2999-01-02T11:55:00.000Z");
    await seedExistingInsights(watermarkFixture, watermarkProcessedAt);
    await store.set(
      insertUsageEvent$,
      {
        orgId: watermarkFixture.orgId,
        userId: watermarkFixture.userId,
        runId: null,
        creditsCharged: 444,
        status: "processed",
        processedAt: watermarkProcessedAt,
      },
      context.signal,
    );
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    const watermarkData = await findInsights(watermarkFixture);
    expect(watermarkData?.creditsUsed).toBe(444);

    // Given: a fixture + 2 completed runs sharing the
    // same displayName "Shared display" + 1 processed
    // credit event for each.

    // When + Then: 200 — 2 agent rows with the same
    // displayName + distinct agentIds + each with
    // runs=1 + credits summing to [100, 200].
    const sharedDisplayFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(sharedDisplayFixture);
    const sharedCompletedAt = new Date("2999-01-02T11:55:00.000Z");
    const sharedFirstRun = await store.set(
      seedRun$,
      {
        orgId: sharedDisplayFixture.orgId,
        userId: sharedDisplayFixture.userId,
        displayName: "Shared display",
        createdAt: sharedCompletedAt,
        startedAt: sharedCompletedAt,
        completedAt: sharedCompletedAt,
      },
      context.signal,
    );
    const sharedSecondRun = await store.set(
      seedRun$,
      {
        orgId: sharedDisplayFixture.orgId,
        userId: sharedDisplayFixture.userId,
        displayName: "Shared display",
        createdAt: sharedCompletedAt,
        startedAt: sharedCompletedAt,
        completedAt: sharedCompletedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: sharedDisplayFixture.orgId,
        userId: sharedDisplayFixture.userId,
        runId: sharedFirstRun.runId,
        creditsCharged: 100,
        status: "processed",
        processedAt: sharedCompletedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: sharedDisplayFixture.orgId,
        userId: sharedDisplayFixture.userId,
        runId: sharedSecondRun.runId,
        creditsCharged: 200,
        status: "processed",
        processedAt: sharedCompletedAt,
      },
      context.signal,
    );
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    const sharedData = await findInsights(sharedDisplayFixture);
    expect(sharedData?.agents).toHaveLength(2);
    expect(
      sharedData?.agents.map((agent) => {
        return agent.agentName;
      }),
    ).toStrictEqual(["Shared display", "Shared display"]);
    expect(
      new Set(
        sharedData?.agents.map((agent) => {
          return agent.agentId;
        }),
      ).size,
    ).toBe(2);
    expect(
      sharedData?.agents.map((agent) => {
        return agent.runs;
      }),
    ).toStrictEqual([1, 1]);
    expect(
      sharedData?.agents
        .map((agent) => {
          return agent.credits;
        })
        .sort((a, b) => {
          return a - b;
        }),
    ).toStrictEqual([100, 200]);

    // Given: a fixture + 1 completed run + 3 Axiom
    // network logs (2 github DENY with empty
    // permission + 1 github ALLOW repo-read).

    // When + Then: 200 — the github permission has
    // denied=2 + the repo-read permission has
    // allowed=1.
    const deniedFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const deniedCompletedAt = new Date("2999-01-02T11:55:00.000Z");
    const { runId: deniedRunId } = await store.set(
      seedRun$,
      {
        orgId: deniedFixture.orgId,
        userId: deniedFixture.userId,
        createdAt: deniedCompletedAt,
        startedAt: deniedCompletedAt,
        completedAt: deniedCompletedAt,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: deniedCompletedAt.toISOString(),
        runId: deniedRunId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "",
        action: "DENY",
      },
      {
        _time: deniedCompletedAt.toISOString(),
        runId: deniedRunId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "",
        action: "DENY",
      },
      {
        _time: deniedCompletedAt.toISOString(),
        runId: deniedRunId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "repo-read",
        action: "ALLOW",
      },
    ]);
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    const deniedData = await findInsights(deniedFixture);
    const githubDeny = deniedData?.permissions.find((permission) => {
      return permission.label === "github" && permission.denied > 0;
    });
    expect(githubDeny).toMatchObject({
      connectorType: "github",
      denied: 2,
    });
    const repoRead = deniedData?.permissions.find((permission) => {
      return permission.label.includes("repo-read");
    });
    expect(repoRead).toMatchObject({
      connectorType: "github",
      allowed: 1,
    });

    // Given: a fixture + a user name + a previous-day
    // run + a same-day processed credit event for 25
    // credits + 1 same-day Axiom log (slack
    // send_message ALLOW).

    // When + Then: 200 — creditsUsed=25 + 1 agent
    // with runs=0 + credits=25 + 1 service domain
    // =slack calls=1.
    const attributedFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(attributedFixture);
    const attributedPreviousDay = new Date("2999-01-01T10:00:00.000Z");
    const attributedProcessedAt = new Date("2999-01-02T11:55:00.000Z");
    const { runId: attributedRunId } = await store.set(
      seedRun$,
      {
        orgId: attributedFixture.orgId,
        userId: attributedFixture.userId,
        createdAt: attributedPreviousDay,
        startedAt: attributedPreviousDay,
        completedAt: new Date("2999-01-01T10:01:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: attributedFixture.orgId,
        userId: attributedFixture.userId,
        runId: attributedRunId,
        creditsCharged: 25,
        status: "processed",
        processedAt: attributedProcessedAt,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: attributedProcessedAt.toISOString(),
        runId: attributedRunId,
        host: "api.slack.com",
        firewall_name: "slack",
        firewall_permission: "send_message",
        action: "ALLOW",
      },
    ]);
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    const attributedData = await findInsights(attributedFixture);
    expect(attributedData?.creditsUsed).toBe(25);
    expect(attributedData?.agents).toMatchObject([{ runs: 0, credits: 25 }]);
    expect(attributedData?.services).toStrictEqual([
      { domain: "slack", calls: 1, agentNames: [expect.any(String)] },
    ]);

    // Given: 2 fixtures (Alice with name="Alice" + Bob
    // with name=null) + 1 runless processed credit
    // event for each.

    // When + Then: 200 — Alice's teamUsage name=Alice
    // + Bob's teamUsage name="bob" (email-prefix
    // fallback).
    const aliceFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const bobFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(aliceFixture, "alice@example.com", "Alice");
    await seedUserName(bobFixture, "bob@example.com", null);
    const namesProcessedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      insertUsageEvent$,
      {
        orgId: aliceFixture.orgId,
        userId: aliceFixture.userId,
        runId: null,
        creditsCharged: 200,
        status: "processed",
        processedAt: namesProcessedAt,
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
        processedAt: namesProcessedAt,
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
});

describe("BDD GET /api/cron/aggregate-insights — idempotency + degraded chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
    context.mocks.axiom.query.mockResolvedValue([]);
  });

  afterEach(() => {
    clearMockedEnv();
    clearMockNow();
  });

  it("gwt-wt-wt: 200 idempotent on rerun → 200 marks insights degraded when Axiom query fails", async () => {
    // Given: a fixture + 1 completed run.

    // When: 2 consecutive aggregates run.

    // Then: the insights persist 1 agent with runs=1
    // (no double-counting).
    const idempotentFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const idempotentCompletedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      seedRun$,
      {
        orgId: idempotentFixture.orgId,
        userId: idempotentFixture.userId,
        createdAt: idempotentCompletedAt,
        startedAt: idempotentCompletedAt,
        completedAt: idempotentCompletedAt,
      },
      context.signal,
    );
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
    const idempotentData = await findInsights(idempotentFixture);
    expect(idempotentData?.agents).toMatchObject([{ runs: 1 }]);

    // Given: a fixture + a user name + 1 completed
    // run + an Axiom query that rejects with an
    // error.

    // When + Then: 200 — users=1 + networkRows=0 +
    // axiomDegraded is true.
    const degradedFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedUserName(degradedFixture);
    const degradedCompletedAt = new Date("2999-01-02T11:55:00.000Z");
    await store.set(
      seedRun$,
      {
        orgId: degradedFixture.orgId,
        userId: degradedFixture.userId,
        createdAt: degradedCompletedAt,
        startedAt: degradedCompletedAt,
        completedAt: degradedCompletedAt,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockRejectedValue(new Error("axiom down"));
    const degradedResponse = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );
    expect(degradedResponse.body).toMatchObject({
      networkRows: 0,
    });
    const degradedData = await findInsights(degradedFixture);
    expect(degradedData?.axiomDegraded).toBeTruthy();
  });
});
