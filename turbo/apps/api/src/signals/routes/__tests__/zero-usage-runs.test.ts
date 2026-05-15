import { randomUUID } from "node:crypto";

import { zeroUsageRunsContract } from "@vm0/api-contracts/contracts/zero-usage-daily";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageFixture$,
  insertModelUsage$,
  insertUsageEvent$,
  seedRun$,
  seedUsageFixture$,
  type UsageFixture,
} from "./helpers/zero-usage";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUsageRunsContract);
}

function userIdsFromClerkRequest(args: unknown): string[] {
  if (typeof args !== "object" || args === null) {
    return [];
  }
  const value = Reflect.get(args, "userId");
  if (
    Array.isArray(value) &&
    value.every((item): item is string => {
      return typeof item === "string";
    })
  ) {
    return value;
  }
  return [];
}

function mockClerkUserLookup(): void {
  context.mocks.clerk.users.getUserList.mockImplementation((args: unknown) => {
    return Promise.resolve({
      data: userIdsFromClerkRequest(args).map((userId) => {
        const emailId = `email_${userId}`;
        return {
          id: userId,
          primaryEmailAddressId: emailId,
          emailAddresses: [
            { id: emailId, emailAddress: `${userId}@example.com` },
          ],
        };
      }),
    });
  });
}

function createdAt(minutesAgo: number): Date {
  return new Date(nowDate().getTime() - minutesAgo * 60 * 1000);
}

describe("GET /api/zero/usage/runs", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return store.set(deleteUsageFixture$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for non-admin users", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can view run usage",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns empty result when no runs have processed usage events", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });

  it("returns per-run records with credit totals", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const older = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: createdAt(10),
      },
      context.signal,
    );
    const newer = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId, createdAt: createdAt(1) },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: older.runId,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: newer.runId,
        inputTokens: 2000,
        outputTokens: 1000,
        creditsCharged: 100,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.runs).toHaveLength(2);
    expect(response.body.pagination.total).toBe(2);
    expect(response.body.runs[0]?.runId).toBe(newer.runId);
    expect(response.body.runs[0]?.creditsCharged).toBe(100);
    expect(response.body.runs[1]?.runId).toBe(older.runId);
    expect(response.body.runs[1]?.creditsCharged).toBe(50);
  });

  it("paginates results correctly", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    for (let index = 0; index < 3; index++) {
      const run = await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          createdAt: createdAt(10 - index),
        },
        context.signal,
      );
      await store.set(
        insertModelUsage$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          runId: run.runId,
          creditsCharged: (index + 1) * 10,
        },
        context.signal,
      );
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response1 = await accept(
      apiClient().get({
        query: { page: 1, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response1.body.runs).toHaveLength(2);
    expect(response1.body.pagination).toStrictEqual({
      page: 1,
      pageSize: 2,
      total: 3,
    });

    const response2 = await accept(
      apiClient().get({
        query: { page: 2, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response2.body.runs).toHaveLength(1);
    expect(response2.body.pagination.page).toBe(2);
  });

  it("filters by userIds", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const user1 = `user_${randomUUID()}`;
    const user2 = `user_${randomUUID()}`;
    const run1 = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: user1, createdAt: createdAt(2) },
      context.signal,
    );
    const run2 = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: user2, createdAt: createdAt(1) },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: user1,
        runId: run1.runId,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: user2,
        runId: run2.runId,
        creditsCharged: 100,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { userIds: ` ${user1}, ` },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]?.userId).toBe(user1);
    expect(response.body.runs[0]?.creditsCharged).toBe(50);
  });

  it("filters by agentId", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const included = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId, createdAt: createdAt(2) },
      context.signal,
    );
    const excluded = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId, createdAt: createdAt(1) },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: included.runId,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: excluded.runId,
        creditsCharged: 100,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { agentId: included.composeId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(
      response.body.runs.map((run) => {
        return run.runId;
      }),
    ).toStrictEqual([included.runId]);
    expect(response.body.runs[0]?.creditsCharged).toBe(50);
  });

  it("filters by created-at date range", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const dateFrom = new Date("2026-01-10T00:00:00.000Z");
    const dateTo = new Date("2026-01-11T00:00:00.000Z");
    const before = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: new Date("2026-01-09T12:00:00.000Z"),
      },
      context.signal,
    );
    const inside = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: new Date("2026-01-10T12:00:00.000Z"),
      },
      context.signal,
    );
    const endBoundary = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: dateTo,
      },
      context.signal,
    );
    const after = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: new Date("2026-01-11T12:00:00.000Z"),
      },
      context.signal,
    );
    for (const run of [before, inside, endBoundary, after]) {
      await store.set(
        insertModelUsage$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          runId: run.runId,
          creditsCharged: 50,
        },
        context.signal,
      );
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: {
          dateFrom: dateFrom.toISOString(),
          dateTo: dateTo.toISOString(),
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(
      response.body.runs.map((run) => {
        return run.runId;
      }),
    ).toStrictEqual([inside.runId]);
    expect(response.body.pagination.total).toBe(1);
  });

  it("excludes runs with only pending usage events", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const processed = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId, createdAt: createdAt(2) },
      context.signal,
    );
    const pending = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId, createdAt: createdAt(1) },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: processed.runId,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: pending.runId,
        creditsCharged: 0,
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]?.runId).toBe(processed.runId);
    expect(response.body.runs[0]?.creditsCharged).toBe(50);
  });

  it("returns run-linked usage_event records and excludes runless events", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const run = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 300,
        creditsCharged: 30,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        creditsCharged: 20,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        creditsCharged: 999,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.runs[0]).toMatchObject({
      runId: run.runId,
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      outputTokens: 0,
      cacheTokens: 0,
      creditsCharged: 50,
    });
  });

  it("sums multiple usage_event totals for the same run", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const run = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
        creditsCharged: 40,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 30,
        creditsCharged: 3,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.output",
        quantity: 70,
        creditsCharged: 7,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.cache_read",
        quantity: 11,
        creditsCharged: 1,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.cache_creation",
        quantity: 13,
        creditsCharged: 2,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 9999,
        creditsCharged: 999,
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.runs[0]).toMatchObject({
      runId: run.runId,
      inputTokens: 130,
      outputTokens: 120,
      cacheTokens: 54,
      creditsCharged: 53,
    });
  });
});
