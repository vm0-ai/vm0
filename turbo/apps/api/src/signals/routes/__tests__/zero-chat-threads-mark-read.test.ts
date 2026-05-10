import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { chatThreadMarkReadContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteZeroChatThread$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("POST /api/zero/chat-threads/:id/mark-read", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadMarkReadContract);

    const response = await accept(
      client.markRead({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown thread id", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMarkReadContract);

    const response = await accept(
      client.markRead({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for a thread owned by another user (cross-user isolation)", async () => {
    const otherFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: `user_${randomUUID().slice(0, 8)}` },
        context.signal,
      ),
    );
    // Authenticate as a different user — must not see another user's thread.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    const client = setupApp({ context })(chatThreadMarkReadContract);

    const response = await accept(
      client.markRead({
        params: { id: otherFixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("stores the latest visible message id, persists it, and publishes both signals", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "older",
        createdAt: new Date("2024-01-01T00:00:00Z"),
      },
      context.signal,
    );
    const latestId = await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "latest",
        createdAt: new Date("2024-01-01T00:01:00Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMarkReadContract);

    const response = await accept(
      client.markRead({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      lastReadMessageId: latestId,
      changed: true,
    });

    // DB read-after-write
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ lastReadMessageId: chatThreads.lastReadMessageId })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    expect(row?.lastReadMessageId).toBe(latestId);

    // Both Ably signals published with web-equivalent payloads.
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadReadCursorUpdated:${fixture.threadId}`,
      { lastReadMessageId: latestId },
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("returns changed:false and does NOT publish when stored already matches latest", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const messageId = await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "assistant", content: "only" },
      context.signal,
    );
    // Pre-stamp last-read = latest before the request
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(chatThreads)
      .set({ lastReadMessageId: messageId })
      .where(eq(chatThreads.id, fixture.threadId));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMarkReadContract);

    const response = await accept(
      client.markRead({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      lastReadMessageId: messageId,
      changed: false,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns changed:false with null id when the thread has no messages", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMarkReadContract);

    const response = await accept(
      client.markRead({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      lastReadMessageId: null,
      changed: false,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("is idempotent — a second call after a successful mark is a no-op", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const messageId = await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "assistant", content: "msg" },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMarkReadContract);

    const first = await accept(
      client.markRead({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(first.body).toStrictEqual({
      lastReadMessageId: messageId,
      changed: true,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);

    context.mocks.ably.publish.mockClear();

    const second = await accept(
      client.markRead({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(second.body).toStrictEqual({
      lastReadMessageId: messageId,
      changed: false,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
