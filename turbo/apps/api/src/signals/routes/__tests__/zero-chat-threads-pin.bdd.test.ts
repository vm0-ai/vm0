import { randomUUID } from "node:crypto";

import {
  chatThreadPinContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";
import { delay } from "signal-timers";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-chat-threads-pin.test.ts`. The
// Given uses `seedZeroChatThread$` (recorded under "Open Helper Gaps"
// in `api.bdd.md`). The legacy direct DB SELECT that verified
// `pinnedAt` is replaced by assertions on the public
// `chatThreadsContract.list` response (which carries `pinnedAt`). The
// 5 legacy `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function pinClient() {
  return setupApp({ context })(chatThreadPinContract);
}

function listClient() {
  return setupApp({ context })(chatThreadsContract);
}

describe("BDD POST /api/zero/chat-threads/:id/pin — auth boundary", () => {
  it("returns 401 when unauthenticated and does not publish to Ably", async () => {
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401.
    const response = await accept(
      pinClient().pin({
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

describe("BDD POST /api/zero/chat-threads/:id/pin — pin chain", () => {
  it("gwt-wt-wt: 404 missing → 404 cross-user (verified via list) → 204 own (verified via list) → 204 re-pin (verified via list)", async () => {
    context.mocks.ably.publish.mockClear();
    const c = pinClient();

    // Given: a fresh user/org with no chat threads.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: pin on an unknown thread returns 404 and does
    // not publish.
    const missing = await accept(
      c.pin({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a different user owns a thread; the caller is
    // authenticated as a different user in the same org.
    const otherFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: `user_${randomUUID().slice(0, 8)}` },
        context.signal,
      ),
    );
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    // When + Then: pin returns 404 (no existence leak) and the
    // victim's thread is not pinned — verified via the LIST
    // endpoint by the victim after re-authenticating.
    const crossUser = await accept(
      c.pin({ params: { id: otherFixture.threadId }, headers: authHeaders() }),
      [404],
    );
    expect(crossUser.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Re-authenticate as the victim and confirm `pinnedAt` is null
    // for the victim's thread. The list response separates pinned
    // threads from non-pinned threads.
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    const victimList = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const victimPinned = victimList.body.pinned.find((thread) => {
      return thread.id === otherFixture.threadId;
    });
    expect(victimPinned).toBeUndefined();

    // Given: the original caller's thread (auth restored).
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const beforeAt = now();

    // When: the caller pins their own thread.
    await accept(
      c.pin({ params: { id: fixture.threadId }, headers: authHeaders() }),
      [204],
    );

    // Then: the LIST endpoint shows `pinnedAt` is set to a recent
    // timestamp and Ably was published to once with
    // `threadListChanged`.
    const afterList = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const pinnedRow = afterList.body.pinned.find((thread) => {
      return thread.id === fixture.threadId;
    });
    expect(pinnedRow?.pinnedAt).toBeTruthy();
    const pinnedAtMs = new Date(pinnedRow!.pinnedAt!).getTime();
    expect(pinnedAtMs).toBeGreaterThanOrEqual(beforeAt - 1000);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    context.mocks.ably.publish.mockClear();

    // Given: the thread is already pinned.
    // When: the caller pins it again (small delay to ensure a
    // different timestamp).
    await delay(10, { signal: context.signal });

    await accept(
      c.pin({ params: { id: fixture.threadId }, headers: authHeaders() }),
      [204],
    );

    // Then: the LIST endpoint still shows the thread in `pinned`
    // with a fresher `pinnedAt` and Ably was published to again.
    const afterSecond = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const secondRow = afterSecond.body.pinned.find((thread) => {
      return thread.id === fixture.threadId;
    });
    expect(secondRow?.pinnedAt).toBeTruthy();
    const secondPinnedAtMs = new Date(secondRow!.pinnedAt!).getTime();
    expect(secondPinnedAtMs).toBeGreaterThanOrEqual(pinnedAtMs);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
