import { randomUUID } from "node:crypto";

import { chatThreadMarkReadContract } from "@vm0/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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

// BDD migration of the legacy `zero-chat-threads-mark-read.test.ts`. The
// markRead contract response already carries `lastReadMessageId` and
// `changed`, so the legacy direct DB SELECT that verified the persisted
// cursor is replaced by assertions on the public response body. The 7
// legacy `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function markReadClient() {
  return setupApp({ context })(chatThreadMarkReadContract);
}

describe("BDD POST /api/zero/chat-threads/:id/mark-read — auth boundary", () => {
  it("returns 401 when unauthenticated and does not publish to Ably", async () => {
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401.
    const response = await accept(
      markReadClient().markRead({
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
});

const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

describe("BDD POST /api/zero/chat-threads/:id/mark-read — read cursor chain", () => {
  it("gwt-wt-wt: 404 missing → 404 cross-user → 200 with-cursor (2 ably publishes) → 200 no-messages (null cursor) → 200 idempotent (changed:false)", async () => {
    context.mocks.ably.publish.mockClear();
    const c = markReadClient();

    // Given: a fresh user/org with no chat threads.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: mark-read on an unknown thread returns 404 and does
    // not publish.
    const missing = await accept(
      c.markRead({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a different user owns a thread with one assistant message;
    // the caller is authenticated as a different user in the same org.
    const otherFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: `user_${randomUUID().slice(0, 8)}` },
        context.signal,
      ),
    );
    const otherMessageId = await store.set(
      seedZeroChatMessage$,
      otherFixture,
      { role: "assistant", content: "latest" },
      context.signal,
    );
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    // When + Then: mark-read returns 404 (no existence leak) and does
    // not publish.
    const crossUser = await accept(
      c.markRead({
        params: { id: otherFixture.threadId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: the caller's own thread with two messages (older + latest).
    mocks.clerk.session(fixture.userId, fixture.orgId);
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

    // When: the caller marks their own thread as read.
    const marked = await accept(
      c.markRead({ params: { id: fixture.threadId }, headers: authHeaders() }),
      [200],
    );

    // Then: the response carries the latest message id with `changed: true`
    // and Ably was published to twice — the per-thread cursor signal and
    // the global `threadListChanged` signal.
    expect(marked.body).toStrictEqual({
      lastReadMessageId: latestId,
      changed: true,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadReadCursorUpdated:${fixture.threadId}`,
      { lastReadMessageId: latestId },
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    context.mocks.ably.publish.mockClear();

    // Given: the thread was just marked up-to-date.
    // When: the caller marks it read again (idempotent — cursor unchanged).
    const idempotent = await accept(
      c.markRead({ params: { id: fixture.threadId }, headers: authHeaders() }),
      [200],
    );

    // Then: the response still carries the same id with `changed: false`
    // and Ably is not published to (cursor is already up-to-date).
    expect(idempotent.body).toStrictEqual({
      lastReadMessageId: latestId,
      changed: false,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a different thread with no messages at all.
    const emptyFixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);

    // When + Then: mark-read on an empty thread returns `null` cursor
    // with `changed: false` and no Ably publishes.
    const empty = await accept(
      c.markRead({
        params: { id: emptyFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(empty.body).toStrictEqual({
      lastReadMessageId: null,
      changed: false,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Reference the otherFixture.messageId so its usage is intentional and
    // surfaces in the helper gap audit.
    expect(otherMessageId).toBeTruthy();
  });
});
