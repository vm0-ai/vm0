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

  it("returns the user's chats ordered by recent activity", async () => {
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

    expect(response.body.chats).toHaveLength(2);
    expect(response.body.pagination.total).toBe(2);
    expect(response.body.chats[0]?.threadId).toBe(newer.threadId);
    expect(response.body.chats[0]?.threadTitle).toBe("Newer chat");
    expect(response.body.chats[0]?.credits).toBe(250);
    expect(response.body.chats[0]?.tokens).toBe(300);
    expect(response.body.chats[1]?.threadId).toBe(older.threadId);
    expect(response.body.chats[1]?.credits).toBe(80);
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

    expect(response.body.chats).toHaveLength(2);
    expect(response.body.pagination.total).toBe(3);
    expect(response.body.chats[0]?.threadTitle).toBe("Chat 10");
    expect(response.body.chats[1]?.threadTitle).toBe("Chat 20");
  });
});
