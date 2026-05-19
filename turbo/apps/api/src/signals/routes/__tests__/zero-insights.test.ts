import { randomUUID } from "node:crypto";

import {
  zeroInsightsContract,
  zeroInsightsRangeContract,
} from "@vm0/api-contracts/contracts/zero-insights";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import {
  deleteInsightsForFixture$,
  seedInsightsDaily$,
  seedInsightsFixture$,
  type InsightsFixture,
} from "./helpers/zero-insights";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroInsightsContract);
}

function apiRangeClient() {
  return setupApp({ context })(zeroInsightsRangeContract);
}

function daysAgo(n: number): string {
  const d = nowDate();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function defaultInsightData(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    agents: [
      { agentName: "Test Agent", agentId: "agent-1", runs: 5, credits: 100 },
    ],
    creditsUsed: 100,
    creditBalance: 9900,
    teamUsage: [{ name: "alice", credits: 100 }],
    topTask: { name: "Send message", count: 10 },
    services: [
      {
        name: "api.slack.com",
        domain: "api.slack.com",
        calls: 10,
        agentNames: ["Test Agent"],
      },
    ],
    permissions: [
      {
        label: "chat:write",
        allowed: 8,
        denied: 2,
        agentNames: ["Test Agent"],
      },
    ],
    ...overrides,
  };
}

describe("GET /api/zero/insights", () => {
  const track = createFixtureTracker<InsightsFixture>((fixture) => {
    return store.set(deleteInsightsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty days when no insights exist", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toStrictEqual([]);
    expect(response.body.totalCredits).toBe(0);
    expect(response.body.totalRuns).toBe(0);
    expect(response.body.lastUpdated).toBeNull();
  });

  it("returns insights with correct structure", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const yesterday = daysAgo(1);
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: yesterday,
        data: defaultInsightData(),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toHaveLength(1);
    const day = response.body.days[0];
    expect(day?.date).toBe(yesterday);
    expect(day?.agents).toHaveLength(1);
    expect(day?.agents[0]?.agentName).toBe("Test Agent");
    expect(day?.schedules).toStrictEqual([]);
    expect(day?.chats).toStrictEqual([]);
    expect(day?.creditsUsed).toBe(100);
    expect(response.body.totalCredits).toBe(100);
    expect(response.body.totalRuns).toBe(5);
    expect(response.body.lastUpdated).toBeTruthy();
    expect(
      Number.isNaN(new Date(response.body.lastUpdated ?? "").getTime()),
    ).toBeFalsy();
  });

  it("normalizes sparse insight rows to the full day shape", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const yesterday = daysAgo(1);
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: yesterday,
        data: {},
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toStrictEqual([
      {
        date: yesterday,
        agents: [],
        creditsUsed: 0,
        creditBalance: 0,
        teamUsage: [],
        topTask: null,
        services: [],
        permissions: [],
        schedules: [],
        chats: [],
      },
    ]);
    expect(response.body.totalCredits).toBe(0);
    expect(response.body.totalRuns).toBe(0);
    expect(response.body.lastUpdated).toBeTruthy();
  });

  it("aggregates totals across multiple days", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: daysAgo(1),
        data: defaultInsightData(),
      },
      context.signal,
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: daysAgo(2),
        data: defaultInsightData({
          agents: [
            {
              agentName: "Agent B",
              agentId: "agent-2",
              runs: 3,
              credits: 200,
            },
          ],
          creditsUsed: 200,
        }),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toHaveLength(2);
    expect(response.body.totalCredits).toBe(300);
    expect(response.body.totalRuns).toBe(8);
  });

  it("respects days query parameter", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: daysAgo(1),
        data: defaultInsightData(),
      },
      context.signal,
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: daysAgo(2),
        data: defaultInsightData({ creditsUsed: 50 }),
      },
      context.signal,
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: daysAgo(5),
        data: defaultInsightData({ creditsUsed: 75 }),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: { days: 3 }, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toHaveLength(2);
  });

  it("clamps days parameter between 1 and 90", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: daysAgo(0),
        data: defaultInsightData(),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response1 = await accept(
      apiClient().get({ query: { days: 0 }, headers: authHeaders() }),
      [200],
    );
    expect(response1.body.days).toHaveLength(1);

    const response2 = await accept(
      apiClient().get({ query: { days: 200 }, headers: authHeaders() }),
      [200],
    );
    expect(response2.status).toBe(200);
  });

  it("does not return insights from other orgs", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const otherOrgFixture = await track(
      Promise.resolve<InsightsFixture>({
        orgId: `org_${randomUUID()}`,
        userId: fixture.userId,
      }),
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: otherOrgFixture.orgId,
        userId: otherOrgFixture.userId,
        date: daysAgo(1),
        data: defaultInsightData(),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toStrictEqual([]);
  });

  it("does not return insights from other users", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const otherUserFixture = await track(
      Promise.resolve<InsightsFixture>({
        orgId: fixture.orgId,
        userId: `user_${randomUUID()}`,
      }),
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: otherUserFixture.orgId,
        userId: otherUserFixture.userId,
        date: daysAgo(1),
        data: defaultInsightData(),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toStrictEqual([]);
  });

  it("orders days by date descending", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const day1 = daysAgo(3);
    const day2 = daysAgo(1);
    const day3 = daysAgo(2);
    for (const date of [day1, day2, day3]) {
      await store.set(
        seedInsightsDaily$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          date,
          data: defaultInsightData(),
        },
        context.signal,
      );
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toHaveLength(3);
    expect(response.body.days[0]?.date).toBe(day2);
    expect(response.body.days[1]?.date).toBe(day3);
    expect(response.body.days[2]?.date).toBe(day1);
  });
});

describe("GET /api/zero/insights/range", () => {
  const track = createFixtureTracker<InsightsFixture>((fixture) => {
    return store.set(deleteInsightsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(apiRangeClient().get({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      apiRangeClient().get({ headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns nulls when no insights exist", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiRangeClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.minDate).toBeNull();
    expect(response.body.maxDate).toBeNull();
    expect(response.body.totalDays).toBe(0);
  });

  it("returns correct range for a single day", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const date = daysAgo(1);
    await store.set(
      seedInsightsDaily$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date,
        data: defaultInsightData(),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiRangeClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.minDate).toBe(date);
    expect(response.body.maxDate).toBe(date);
    expect(response.body.totalDays).toBe(1);
  });

  it("returns correct range for multiple days", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const day1 = daysAgo(5);
    const day2 = daysAgo(3);
    const day3 = daysAgo(1);
    for (const date of [day1, day2, day3]) {
      await store.set(
        seedInsightsDaily$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          date,
          data: defaultInsightData(),
        },
        context.signal,
      );
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiRangeClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.minDate).toBe(day1);
    expect(response.body.maxDate).toBe(day3);
    expect(response.body.totalDays).toBe(3);
  });

  it("does not include insights from other orgs", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const otherOrgFixture = await track(
      Promise.resolve<InsightsFixture>({
        orgId: `org_${randomUUID()}`,
        userId: fixture.userId,
      }),
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: otherOrgFixture.orgId,
        userId: otherOrgFixture.userId,
        date: daysAgo(1),
        data: defaultInsightData(),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiRangeClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.minDate).toBeNull();
    expect(response.body.maxDate).toBeNull();
    expect(response.body.totalDays).toBe(0);
  });

  it("does not include insights from other users", async () => {
    const fixture = await track(
      store.set(seedInsightsFixture$, undefined, context.signal),
    );
    const otherUserFixture = await track(
      Promise.resolve<InsightsFixture>({
        orgId: fixture.orgId,
        userId: `user_${randomUUID()}`,
      }),
    );
    await store.set(
      seedInsightsDaily$,
      {
        orgId: otherUserFixture.orgId,
        userId: otherUserFixture.userId,
        date: daysAgo(1),
        data: defaultInsightData(),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiRangeClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.minDate).toBeNull();
    expect(response.body.maxDate).toBeNull();
    expect(response.body.totalDays).toBe(0);
  });
});
