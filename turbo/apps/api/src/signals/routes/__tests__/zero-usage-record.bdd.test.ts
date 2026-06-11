import { zeroUsageRecordContract } from "@vm0/api-contracts/contracts/zero-usage-record";
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
  seedChatThreadRun$,
  seedRun$,
  seedUsageFixture$,
  type UsageFixture,
} from "./helpers/zero-usage";

// BDD migration of the legacy `zero-usage-record.test.ts`.
// The 6 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// auth + multi-source chain (401 unauthenticated → 200
// returns rows across sources ordered by recent activity),
// (2) source + thread chain (200 labels schedule threads
// and filters by source → 200 keeps chat and schedule
// usage separate within the same thread), (3) trigger +
// pagination chain (200 normalizes unsupported trigger
// sources to other → 200 paginates by page size).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUsageRecordContract);
}

function createdAt(minutesAgo: number): Date {
  return new Date(nowDate().getTime() - minutesAgo * 60 * 1000);
}

describe("BDD GET /api/zero/usage/record — auth + multi-source chain", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return store.set(deleteUsageFixture$, fixture, context.signal);
  });

  it("gwt-wt-wt: 401 unauthenticated → 200 returns rows across sources ordered by recent activity", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fresh usage fixture + an older chat run +
    // a slack run + a newer chat run (each with
    // modelUsage rows).
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const older = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Older chat",
        createdAt: createdAt(120),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: older.runId,
        inputTokens: 100,
        outputTokens: 50,
        creditsCharged: 80,
      },
      context.signal,
    );
    const slack = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        prompt: "Slack triage",
        triggerSource: "slack",
        createdAt: createdAt(60),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: slack.runId,
        inputTokens: 30,
        outputTokens: 20,
        creditsCharged: 40,
      },
      context.signal,
    );
    const newer = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Newer chat",
        createdAt: createdAt(5),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: newer.runId,
        inputTokens: 200,
        outputTokens: 100,
        creditsCharged: 250,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 — 3 rows ordered by recent
    // activity: chat (newer) → slack → chat (older).
    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(response.body.rows).toHaveLength(3);
    expect(response.body.pagination.total).toBe(3);
    expect(response.body.rows[0]?.source).toBe("chat");
    expect(response.body.rows[0]?.threadId).toBe(newer.threadId);
    expect(response.body.rows[0]?.runId).toBeNull();
    expect(response.body.rows[0]?.title).toBe("Newer chat");
    expect(response.body.rows[0]?.credits).toBe(250);
    expect(response.body.rows[0]?.tokens).toBe(300);
    expect(response.body.rows[1]?.source).toBe("slack");
    expect(response.body.rows[1]?.threadId).toBeNull();
    expect(response.body.rows[1]?.runId).toBe(slack.runId);
    expect(response.body.rows[1]?.title).toBe("Slack triage");
    expect(response.body.rows[1]?.credits).toBe(40);
    expect(response.body.rows[2]?.source).toBe("chat");
    expect(response.body.rows[2]?.threadId).toBe(older.threadId);
    expect(response.body.rows[2]?.credits).toBe(80);
  });
});

describe("BDD GET /api/zero/usage/record — source + thread chain", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return store.set(deleteUsageFixture$, fixture, context.signal);
  });

  it("gwt-wt-wt: 200 labels schedule threads and filters by source → 200 keeps chat and schedule usage separate within the same thread", async () => {
    // Given: a fresh usage fixture + a chat run + a
    // schedule run on a different thread.
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const chat = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "A chat",
        createdAt: createdAt(20),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: chat.runId,
        inputTokens: 10,
        outputTokens: 10,
        creditsCharged: 10,
      },
      context.signal,
    );
    const schedule = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Daily brief",
        triggerSource: "schedule",
        createdAt: createdAt(10),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: schedule.runId,
        inputTokens: 50,
        outputTokens: 50,
        creditsCharged: 120,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 — filtering by `schedule` returns
    // only the schedule run.
    const scheduleResponse = await accept(
      apiClient().get({
        query: { source: "schedule" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(scheduleResponse.body.rows).toHaveLength(1);
    expect(scheduleResponse.body.pagination.total).toBe(1);
    expect(scheduleResponse.body.rows[0]?.source).toBe("schedule");
    expect(scheduleResponse.body.rows[0]?.threadId).toBe(schedule.threadId);
    expect(scheduleResponse.body.rows[0]?.title).toBe("Daily brief");
    expect(scheduleResponse.body.rows[0]?.credits).toBe(120);

    // Given: a fresh usage fixture + a chat thread + a
    // schedule run on the same thread.
    const sharedFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const sharedChat = await store.set(
      seedChatThreadRun$,
      {
        orgId: sharedFixture.orgId,
        userId: sharedFixture.userId,
        title: "Shared thread",
        createdAt: createdAt(30),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: sharedFixture.orgId,
        userId: sharedFixture.userId,
        runId: sharedChat.runId,
        inputTokens: 10,
        outputTokens: 10,
        creditsCharged: 10,
      },
      context.signal,
    );
    const sharedSchedule = await store.set(
      seedChatThreadRun$,
      {
        orgId: sharedFixture.orgId,
        userId: sharedFixture.userId,
        threadId: sharedChat.threadId,
        triggerSource: "schedule",
        createdAt: createdAt(5),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: sharedFixture.orgId,
        userId: sharedFixture.userId,
        runId: sharedSchedule.runId,
        inputTokens: 50,
        outputTokens: 50,
        creditsCharged: 120,
      },
      context.signal,
    );
    mocks.clerk.session(sharedFixture.userId, sharedFixture.orgId);

    // When + Then: 200 — without a source filter, two
    // rows appear (schedule + chat) on the same thread.
    const allResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(allResponse.body.rows).toHaveLength(2);
    expect(allResponse.body.pagination.total).toBe(2);
    expect(allResponse.body.rows[0]).toMatchObject({
      source: "schedule",
      threadId: sharedChat.threadId,
      runId: null,
      title: "Shared thread",
      credits: 120,
      tokens: 100,
    });
    expect(allResponse.body.rows[1]).toMatchObject({
      source: "chat",
      threadId: sharedChat.threadId,
      runId: null,
      title: "Shared thread",
      credits: 10,
      tokens: 20,
    });

    // When + Then: 200 — filtering by `chat` returns
    // only the chat row.
    const chatResponse = await accept(
      apiClient().get({
        query: { source: "chat" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(chatResponse.body.rows).toHaveLength(1);
    expect(chatResponse.body.rows[0]?.source).toBe("chat");
    expect(chatResponse.body.rows[0]?.credits).toBe(10);
  });
});

describe("BDD GET /api/zero/usage/record — trigger + pagination chain", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return store.set(deleteUsageFixture$, fixture, context.signal);
  });

  it("gwt-wt-wt: 200 normalizes unsupported trigger sources to other → 200 paginates by page size", async () => {
    // Given: a fresh usage fixture + a manual trigger
    // run.
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const legacyRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        prompt: "Legacy manual run",
        triggerSource: "manual",
        createdAt: createdAt(10),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: legacyRun.runId,
        inputTokens: 25,
        outputTokens: 5,
        creditsCharged: 30,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 — the manual trigger is
    // normalized to `other` when filtered.
    const otherResponse = await accept(
      apiClient().get({
        query: { source: "other" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(otherResponse.body.rows).toHaveLength(1);
    expect(otherResponse.body.pagination.total).toBe(1);
    expect(otherResponse.body.rows[0]).toMatchObject({
      source: "other",
      threadId: null,
      runId: legacyRun.runId,
      title: "Legacy manual run",
      credits: 30,
      tokens: 30,
    });

    // Given: a fresh usage fixture + 3 chat runs.
    const pageFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    for (const minutesAgo of [30, 20, 10]) {
      const pageChat = await store.set(
        seedChatThreadRun$,
        {
          orgId: pageFixture.orgId,
          userId: pageFixture.userId,
          title: `Chat ${minutesAgo}`,
          createdAt: createdAt(minutesAgo),
        },
        context.signal,
      );
      await store.set(
        insertModelUsage$,
        {
          orgId: pageFixture.orgId,
          userId: pageFixture.userId,
          runId: pageChat.runId,
          inputTokens: 10,
          outputTokens: 10,
          creditsCharged: 10,
        },
        context.signal,
      );
    }
    mocks.clerk.session(pageFixture.userId, pageFixture.orgId);

    // When + Then: 200 — paginates by page size 2 with
    // total 3.
    const pageResponse = await accept(
      apiClient().get({
        query: { page: 1, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(pageResponse.body.rows).toHaveLength(2);
    expect(pageResponse.body.pagination.total).toBe(3);
    expect(pageResponse.body.rows[0]?.title).toBe("Chat 10");
    expect(pageResponse.body.rows[1]?.title).toBe("Chat 20");
  });
});
