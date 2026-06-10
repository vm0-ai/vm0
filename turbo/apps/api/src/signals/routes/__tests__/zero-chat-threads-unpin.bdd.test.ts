import { randomUUID } from "node:crypto";

import {
  chatThreadUnpinContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-chat-threads-unpin.test.ts`. The
// Given uses `seedZeroChatThread$` (recorded under "Open Helper Gaps"
// in `api.bdd.md`). The legacy direct DB SELECT that verified
// `pinnedAt` is replaced by assertions on the public
// `chatThreadsContract.list` response (which carries `pinnedAt` and
// returns pinned threads in a separate `pinned` array). The 5 legacy
// `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function unpinClient() {
  return setupApp({ context })(chatThreadUnpinContract);
}

function listClient() {
  return setupApp({ context })(chatThreadsContract);
}

describe("BDD POST /api/zero/chat-threads/:id/unpin — auth boundary", () => {
  it("returns 401 when unauthenticated and does not publish to Ably", async () => {
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401.
    const response = await accept(
      unpinClient().unpin({
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

describe("BDD POST /api/zero/chat-threads/:id/unpin — unpin chain", () => {
  it("gwt-wt-wt: 404 missing → 404 cross-user (verified via list) → 204 own (verified via list) → 204 idempotent (verified via list)", async () => {
    context.mocks.ably.publish.mockClear();
    const c = unpinClient();

    // Given: a fresh user/org with no chat threads.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: unpin on an unknown thread returns 404 and does
    // not publish.
    const missing = await accept(
      c.unpin({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a different user owns a pinned thread; the caller is
    // authenticated as a different user in the same org.
    const otherPinnedAt = new Date("2024-06-01T00:00:00.000Z");
    const otherFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId: `user_${randomUUID().slice(0, 8)}`,
          pinnedAt: otherPinnedAt,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    // When + Then: unpin returns 404 (no existence leak).
    const crossUser = await accept(
      c.unpin({
        params: { id: otherFixture.threadId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Then: re-authenticate as the victim and confirm the pinned
    // thread is still pinned — verified via the LIST endpoint
    // (pinned threads live in the separate `pinned` array).
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    const victimList = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const victimRow = victimList.body.pinned.find((thread) => {
      return thread.id === otherFixture.threadId;
    });
    expect(victimRow?.pinnedAt).toBeTruthy();

    // Given: the original caller's thread is pinned (auth restored).
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When: the caller unpins their own thread.
    const unpinned = await accept(
      c.unpin({ params: { id: fixture.threadId }, headers: authHeaders() }),
      [204],
    );
    expect(unpinned.body).toBeUndefined();

    // Then: the LIST endpoint shows the thread is no longer in
    // `pinned` and Ably was published to once with
    // `threadListChanged`.
    const afterList = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const stillPinned = afterList.body.pinned.find((thread) => {
      return thread.id === fixture.threadId;
    });
    expect(stillPinned).toBeUndefined();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    context.mocks.ably.publish.mockClear();

    // When: the caller unpins again (idempotent — the thread is
    // already unpinned).
    const idempotent = await accept(
      c.unpin({ params: { id: fixture.threadId }, headers: authHeaders() }),
      [204],
    );
    expect(idempotent.body).toBeUndefined();

    // Then: Ably was published to again and the LIST endpoint
    // still shows the thread as not pinned.
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    const afterSecond = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const stillPinnedSecond = afterSecond.body.pinned.find((thread) => {
      return thread.id === fixture.threadId;
    });
    expect(stillPinnedSecond).toBeUndefined();
  });
});
