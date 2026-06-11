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

// BDD migration of the legacy `zero-usage-runs.test.ts`.
// The 16 legacy `it()`s collapse into 5 BDD `it()`s: (1)
// auth chain (401 unauthenticated → 403 non-admin), (2)
// runId filter chain (200 empty when no runs have usage →
// 200 per-run records with credit totals sorted desc →
// 200 filters by runId → 400 invalid runId format → 200
// empty for runId without processed usage → 200 does not
// leak another org's runId), (3) pagination + userIds
// + agentId filter chain (200 paginates results → 200
// filters by userIds → 200 filters by agentId), (4)
// date-range + pending-exclusion chain (200 filters by
// created-at date range → 200 excludes runs with only
// pending usage events), (5) usage_event aggregation
// chain (200 returns run-linked usage_event records
// excluding runless events → 200 sums multiple
// usage_event totals for the same run + excludes
// pending events).

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

const track = createFixtureTracker<UsageFixture>((fixture) => {
  return store.set(deleteUsageFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/usage/runs — auth chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 403 non-admin", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture + a Clerk session as `org:member`.

    // When + Then: 403 — Only org admins can view run
    // usage.
    const memberFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    mocks.clerk.session(
      memberFixture.userId,
      memberFixture.orgId,
      "org:member",
    );
    const memberResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [403],
    );
    expect(memberResponse.body).toStrictEqual({
      error: {
        message: "Only org admins can view run usage",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("BDD GET /api/zero/usage/runs — runId filter chain", () => {
  it("gwt-wt-wt: 200 empty when no runs have usage → 200 per-run records sorted desc by createdAt → 200 filters by runId → 400 invalid runId format → 200 empty for runId without processed usage → 200 does not leak another org's runId", async () => {
    // Given: a fixture + no runs with usage.

    // When + Then: 200 — empty result + default
    // pagination.
    mockClerkUserLookup();
    const emptyFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);
    const emptyResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(emptyResponse.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });

    // Given: a fixture + 2 runs at different createdAt + a
    // model usage row per run.

    // When + Then: 200 — 2 runs sorted desc by createdAt
    // with summed credit totals.
    mockClerkUserLookup();
    const runsFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const older = await store.set(
      seedRun$,
      {
        orgId: runsFixture.orgId,
        userId: runsFixture.userId,
        createdAt: createdAt(10),
      },
      context.signal,
    );
    const newer = await store.set(
      seedRun$,
      {
        orgId: runsFixture.orgId,
        userId: runsFixture.userId,
        createdAt: createdAt(1),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: runsFixture.orgId,
        userId: runsFixture.userId,
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
        orgId: runsFixture.orgId,
        userId: runsFixture.userId,
        runId: newer.runId,
        inputTokens: 2000,
        outputTokens: 1000,
        creditsCharged: 100,
      },
      context.signal,
    );
    mocks.clerk.session(runsFixture.userId, runsFixture.orgId);
    const runsResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(runsResponse.body.runs).toHaveLength(2);
    expect(runsResponse.body.pagination.total).toBe(2);
    expect(runsResponse.body.runs[0]?.runId).toBe(newer.runId);
    expect(runsResponse.body.runs[0]?.creditsCharged).toBe(100);
    expect(runsResponse.body.runs[1]?.runId).toBe(older.runId);
    expect(runsResponse.body.runs[1]?.creditsCharged).toBe(50);

    // Given: a fixture + 2 runs with model usage + a
    // runId filter.

    // When + Then: 200 — only the matching run is
    // returned with its summed credits.
    mockClerkUserLookup();
    const filterFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const included = await store.set(
      seedRun$,
      {
        orgId: filterFixture.orgId,
        userId: filterFixture.userId,
        createdAt: createdAt(2),
      },
      context.signal,
    );
    const excluded = await store.set(
      seedRun$,
      {
        orgId: filterFixture.orgId,
        userId: filterFixture.userId,
        createdAt: createdAt(1),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: filterFixture.orgId,
        userId: filterFixture.userId,
        runId: included.runId,
        inputTokens: 123,
        outputTokens: 45,
        creditsCharged: 67,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: filterFixture.orgId,
        userId: filterFixture.userId,
        runId: excluded.runId,
        inputTokens: 999,
        outputTokens: 999,
        creditsCharged: 999,
      },
      context.signal,
    );
    mocks.clerk.session(filterFixture.userId, filterFixture.orgId);
    const filterResponse = await accept(
      apiClient().get({
        query: { runId: included.runId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(filterResponse.body.pagination).toStrictEqual({
      page: 1,
      pageSize: 20,
      total: 1,
    });
    expect(filterResponse.body.runs).toHaveLength(1);
    expect(filterResponse.body.runs[0]).toMatchObject({
      runId: included.runId,
      model: "claude-sonnet-4-6",
      inputTokens: 123,
      outputTokens: 45,
      creditsCharged: 67,
    });

    // Given: a fixture + a malformed runId.

    // When + Then: 400 — invalid runId format.
    const badRunIdFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    mocks.clerk.session(badRunIdFixture.userId, badRunIdFixture.orgId);
    const badRunIdResponse = await accept(
      apiClient().get({
        query: { runId: "not-a-uuid" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(badRunIdResponse.body.error.code).toBe("BAD_REQUEST");

    // Given: a fixture + a run with no usage.

    // When + Then: 200 — empty result for runId without
    // processed usage.
    mockClerkUserLookup();
    const noUsageFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const noUsageRun = await store.set(
      seedRun$,
      { orgId: noUsageFixture.orgId, userId: noUsageFixture.userId },
      context.signal,
    );
    mocks.clerk.session(noUsageFixture.userId, noUsageFixture.orgId);
    const noUsageResponse = await accept(
      apiClient().get({
        query: { runId: noUsageRun.runId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(noUsageResponse.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });

    // Given: two fixtures (main + other) + a run in the
    // other org with usage.

    // When + Then: 200 — the other org's runId is not
    // leaked into the main org's response.
    mockClerkUserLookup();
    const crossOrgMain = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const crossOrgOther = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const crossOrgRun = await store.set(
      seedRun$,
      { orgId: crossOrgOther.orgId, userId: crossOrgOther.userId },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: crossOrgOther.orgId,
        userId: crossOrgOther.userId,
        runId: crossOrgRun.runId,
        inputTokens: 100,
        outputTokens: 50,
        creditsCharged: 25,
      },
      context.signal,
    );
    mocks.clerk.session(crossOrgMain.userId, crossOrgMain.orgId);
    const crossOrgResponse = await accept(
      apiClient().get({
        query: { runId: crossOrgRun.runId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(crossOrgResponse.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });
});

describe("BDD GET /api/zero/usage/runs — pagination + userIds + agentId chain", () => {
  it("gwt-wt-wt: 200 paginates results → 200 filters by userIds → 200 filters by agentId", async () => {
    // Given: a fixture + 3 runs at descending createdAt +
    // a model usage row per run.

    // When + Then: 200 — page 1 returns 2 runs, page 2
    // returns 1, totals add up to 3.
    mockClerkUserLookup();
    const pageFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    for (let index = 0; index < 3; index++) {
      const run = await store.set(
        seedRun$,
        {
          orgId: pageFixture.orgId,
          userId: pageFixture.userId,
          createdAt: createdAt(10 - index),
        },
        context.signal,
      );
      await store.set(
        insertModelUsage$,
        {
          orgId: pageFixture.orgId,
          userId: pageFixture.userId,
          runId: run.runId,
          creditsCharged: (index + 1) * 10,
        },
        context.signal,
      );
    }
    mocks.clerk.session(pageFixture.userId, pageFixture.orgId);
    const page1Response = await accept(
      apiClient().get({
        query: { page: 1, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(page1Response.body.runs).toHaveLength(2);
    expect(page1Response.body.pagination).toStrictEqual({
      page: 1,
      pageSize: 2,
      total: 3,
    });
    const page2Response = await accept(
      apiClient().get({
        query: { page: 2, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(page2Response.body.runs).toHaveLength(1);
    expect(page2Response.body.pagination.page).toBe(2);

    // Given: a fixture + 2 runs (one per user) with model
    // usage + a userIds filter.

    // When + Then: 200 — only runs for the requested
    // userIds are returned.
    mockClerkUserLookup();
    const userFilterFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const user1 = `user_${randomUUID()}`;
    const user2 = `user_${randomUUID()}`;
    const user1Run = await store.set(
      seedRun$,
      {
        orgId: userFilterFixture.orgId,
        userId: user1,
        createdAt: createdAt(2),
      },
      context.signal,
    );
    const user2Run = await store.set(
      seedRun$,
      {
        orgId: userFilterFixture.orgId,
        userId: user2,
        createdAt: createdAt(1),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: userFilterFixture.orgId,
        userId: user1,
        runId: user1Run.runId,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: userFilterFixture.orgId,
        userId: user2,
        runId: user2Run.runId,
        creditsCharged: 100,
      },
      context.signal,
    );
    mocks.clerk.session(userFilterFixture.userId, userFilterFixture.orgId);
    const userFilterResponse = await accept(
      apiClient().get({
        query: { userIds: ` ${user1}, ` },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(userFilterResponse.body.runs).toHaveLength(1);
    expect(userFilterResponse.body.runs[0]?.userId).toBe(user1);
    expect(userFilterResponse.body.runs[0]?.creditsCharged).toBe(50);

    // Given: a fixture + 2 runs (with different
    // composeIds) + model usage on each + an agentId
    // filter.

    // When + Then: 200 — only the run tied to the
    // requested agentId is returned.
    mockClerkUserLookup();
    const agentFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const agentIncluded = await store.set(
      seedRun$,
      {
        orgId: agentFixture.orgId,
        userId: agentFixture.userId,
        createdAt: createdAt(2),
      },
      context.signal,
    );
    const agentExcluded = await store.set(
      seedRun$,
      {
        orgId: agentFixture.orgId,
        userId: agentFixture.userId,
        createdAt: createdAt(1),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: agentFixture.orgId,
        userId: agentFixture.userId,
        runId: agentIncluded.runId,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: agentFixture.orgId,
        userId: agentFixture.userId,
        runId: agentExcluded.runId,
        creditsCharged: 100,
      },
      context.signal,
    );
    mocks.clerk.session(agentFixture.userId, agentFixture.orgId);
    const agentResponse = await accept(
      apiClient().get({
        query: { agentId: agentIncluded.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(
      agentResponse.body.runs.map((run) => {
        return run.runId;
      }),
    ).toStrictEqual([agentIncluded.runId]);
    expect(agentResponse.body.runs[0]?.creditsCharged).toBe(50);
  });
});

describe("BDD GET /api/zero/usage/runs — date-range + pending-exclusion chain", () => {
  it("gwt-wt-wt: 200 filters by created-at date range → 200 excludes runs with only pending usage events", async () => {
    // Given: a fixture + 4 runs (before / inside / at
    // endBoundary / after) + model usage on each + a
    // dateFrom + dateTo filter.

    // When + Then: 200 — only the inside + endBoundary
    // runs are returned (inclusive of dateTo).
    mockClerkUserLookup();
    const dateFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const dateFrom = new Date("2026-01-10T00:00:00.000Z");
    const dateTo = new Date("2026-01-11T00:00:00.000Z");
    const beforeRun = await store.set(
      seedRun$,
      {
        orgId: dateFixture.orgId,
        userId: dateFixture.userId,
        createdAt: new Date("2026-01-09T12:00:00.000Z"),
      },
      context.signal,
    );
    const insideRun = await store.set(
      seedRun$,
      {
        orgId: dateFixture.orgId,
        userId: dateFixture.userId,
        createdAt: new Date("2026-01-10T12:00:00.000Z"),
      },
      context.signal,
    );
    const endBoundaryRun = await store.set(
      seedRun$,
      {
        orgId: dateFixture.orgId,
        userId: dateFixture.userId,
        createdAt: dateTo,
      },
      context.signal,
    );
    const afterRun = await store.set(
      seedRun$,
      {
        orgId: dateFixture.orgId,
        userId: dateFixture.userId,
        createdAt: new Date("2026-01-11T12:00:00.000Z"),
      },
      context.signal,
    );
    for (const run of [beforeRun, insideRun, endBoundaryRun, afterRun]) {
      await store.set(
        insertModelUsage$,
        {
          orgId: dateFixture.orgId,
          userId: dateFixture.userId,
          runId: run.runId,
          creditsCharged: 50,
        },
        context.signal,
      );
    }
    mocks.clerk.session(dateFixture.userId, dateFixture.orgId);
    const dateResponse = await accept(
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
      dateResponse.body.runs.map((run) => {
        return run.runId;
      }),
    ).toStrictEqual([insideRun.runId]);
    expect(dateResponse.body.pagination.total).toBe(1);

    // Given: a fixture + 2 runs (one processed, one with
    // only pending usage).

    // When + Then: 200 — only the processed run is
    // returned.
    mockClerkUserLookup();
    const pendingFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const processed = await store.set(
      seedRun$,
      {
        orgId: pendingFixture.orgId,
        userId: pendingFixture.userId,
        createdAt: createdAt(2),
      },
      context.signal,
    );
    const pending = await store.set(
      seedRun$,
      {
        orgId: pendingFixture.orgId,
        userId: pendingFixture.userId,
        createdAt: createdAt(1),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: pendingFixture.orgId,
        userId: pendingFixture.userId,
        runId: processed.runId,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: pendingFixture.orgId,
        userId: pendingFixture.userId,
        runId: pending.runId,
        creditsCharged: 0,
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(pendingFixture.userId, pendingFixture.orgId);
    const pendingResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(pendingResponse.body.runs).toHaveLength(1);
    expect(pendingResponse.body.runs[0]?.runId).toBe(processed.runId);
    expect(pendingResponse.body.runs[0]?.creditsCharged).toBe(50);
  });
});

describe("BDD GET /api/zero/usage/runs — usage_event aggregation chain", () => {
  it("gwt-wt-wt: 200 returns run-linked usage_event records excluding runless events → 200 sums multiple usage_event totals for the same run + excludes pending events", async () => {
    // Given: a fixture + a run + 2 run-linked usage
    // events (1 token + 1 bare credit) + 1 runless usage
    // event.

    // When + Then: 200 — 1 run, model + events merged,
    // runless event excluded.
    mockClerkUserLookup();
    const linkedFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const linkedRun = await store.set(
      seedRun$,
      { orgId: linkedFixture.orgId, userId: linkedFixture.userId },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: linkedFixture.orgId,
        userId: linkedFixture.userId,
        runId: linkedRun.runId,
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
        orgId: linkedFixture.orgId,
        userId: linkedFixture.userId,
        runId: linkedRun.runId,
        creditsCharged: 20,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: linkedFixture.orgId,
        userId: linkedFixture.userId,
        creditsCharged: 999,
      },
      context.signal,
    );
    mocks.clerk.session(linkedFixture.userId, linkedFixture.orgId);
    const linkedResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(linkedResponse.body.runs).toHaveLength(1);
    expect(linkedResponse.body.pagination.total).toBe(1);
    expect(linkedResponse.body.runs[0]).toMatchObject({
      runId: linkedRun.runId,
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      outputTokens: 0,
      cacheTokens: 0,
      creditsCharged: 50,
    });

    // Given: a fixture + a run + 1 model usage + 4
    // run-linked usage events (4 token categories) + 1
    // pending run-linked event.

    // When + Then: 200 — 1 run, model + events merged,
    // pending event excluded.
    mockClerkUserLookup();
    const sumFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const sumRun = await store.set(
      seedRun$,
      { orgId: sumFixture.orgId, userId: sumFixture.userId },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: sumFixture.orgId,
        userId: sumFixture.userId,
        runId: sumRun.runId,
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
        orgId: sumFixture.orgId,
        userId: sumFixture.userId,
        runId: sumRun.runId,
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
        orgId: sumFixture.orgId,
        userId: sumFixture.userId,
        runId: sumRun.runId,
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
        orgId: sumFixture.orgId,
        userId: sumFixture.userId,
        runId: sumRun.runId,
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
        orgId: sumFixture.orgId,
        userId: sumFixture.userId,
        runId: sumRun.runId,
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
        orgId: sumFixture.orgId,
        userId: sumFixture.userId,
        runId: sumRun.runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 9999,
        creditsCharged: 999,
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(sumFixture.userId, sumFixture.orgId);
    const sumResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(sumResponse.body.runs).toHaveLength(1);
    expect(sumResponse.body.pagination.total).toBe(1);
    expect(sumResponse.body.runs[0]).toMatchObject({
      runId: sumRun.runId,
      inputTokens: 130,
      outputTokens: 120,
      cacheTokens: 54,
      creditsCharged: 53,
    });
  });
});
