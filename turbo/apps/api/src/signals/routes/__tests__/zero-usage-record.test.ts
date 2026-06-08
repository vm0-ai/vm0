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

describe("GET /api/zero/usage/record", () => {
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

  it("returns rows across sources ordered by recent activity", async () => {
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

    // Unthreaded Slack run — one row per run, links via runId.
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

  it("labels schedule threads and filters by source", async () => {
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

    const response = await accept(
      apiClient().get({
        query: { source: "schedule" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.rows[0]?.source).toBe("schedule");
    expect(response.body.rows[0]?.threadId).toBe(schedule.threadId);
    expect(response.body.rows[0]?.title).toBe("Daily brief");
    expect(response.body.rows[0]?.credits).toBe(120);
  });

  it("keeps chat and schedule usage separate within the same thread", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );

    const chat = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Shared thread",
        createdAt: createdAt(30),
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
        threadId: chat.threadId,
        triggerSource: "schedule",
        createdAt: createdAt(5),
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

    const allResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(allResponse.body.rows).toHaveLength(2);
    expect(allResponse.body.pagination.total).toBe(2);
    expect(allResponse.body.rows[0]).toMatchObject({
      source: "schedule",
      threadId: chat.threadId,
      runId: null,
      title: "Shared thread",
      credits: 120,
      tokens: 100,
    });
    expect(allResponse.body.rows[1]).toMatchObject({
      source: "chat",
      threadId: chat.threadId,
      runId: null,
      title: "Shared thread",
      credits: 10,
      tokens: 20,
    });

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

  it("normalizes unsupported trigger sources to other", async () => {
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

    const response = await accept(
      apiClient().get({
        query: { source: "other" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.rows[0]).toMatchObject({
      source: "other",
      threadId: null,
      runId: legacyRun.runId,
      title: "Legacy manual run",
      credits: 30,
      tokens: 30,
    });
  });

  it("paginates by page size", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );

    for (const minutesAgo of [30, 20, 10]) {
      const chat = await store.set(
        seedChatThreadRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          title: `Chat ${minutesAgo}`,
          createdAt: createdAt(minutesAgo),
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
    }

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { page: 1, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(2);
    expect(response.body.pagination.total).toBe(3);
    expect(response.body.rows[0]?.title).toBe("Chat 10");
    expect(response.body.rows[1]?.title).toBe("Chat 20");
  });
});
