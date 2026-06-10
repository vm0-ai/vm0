import { randomUUID } from "node:crypto";

import {
  chatThreadRenameContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";
import { delay } from "signal-timers";

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

// BDD migration of the legacy `zero-chat-threads-rename.test.ts`. The
// Given uses `seedZeroChatThread$` (recorded under "Open Helper Gaps"
// in `api.bdd.md`). The legacy direct DB SELECT that verified
// `title` and `renamedAt` is replaced by assertions on the public
// `chatThreadsContract.list` response. The 5 legacy `it()`s collapse
// into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function renameClient() {
  return setupApp({ context })(chatThreadRenameContract);
}

function listClient() {
  return setupApp({ context })(chatThreadsContract);
}

describe("BDD POST /api/zero/chat-threads/:id/rename — auth boundary", () => {
  it("returns 401 when unauthenticated and does not publish to Ably", async () => {
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401.
    const response = await accept(
      renameClient().rename({
        params: { id: randomUUID() },
        headers: {},
        body: { title: "Renamed" },
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

describe("BDD POST /api/zero/chat-threads/:id/rename — rename chain", () => {
  it("gwt-wt-wt: 404 missing → 404 cross-user (title preserved via list) → 204 own (verified via list) → 204 re-rename (verified via list)", async () => {
    context.mocks.ably.publish.mockClear();
    const c = renameClient();

    // Given: a fresh user/org with no chat threads.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: rename on an unknown thread returns 404 and does
    // not publish.
    const missing = await accept(
      c.rename({
        params: { id: randomUUID() },
        headers: authHeaders(),
        body: { title: "Renamed" },
      }),
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

    // When + Then: rename returns 404 (no existence leak) and the
    // victim's thread title is preserved — verified via the LIST
    // endpoint by the victim after re-authenticating.
    const crossUser = await accept(
      c.rename({
        params: { id: otherFixture.threadId },
        headers: authHeaders(),
        body: { title: "Hijacked" },
      }),
      [404],
    );
    expect(crossUser.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    const victimList = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const victimRow = [
      ...victimList.body.pinned,
      ...victimList.body.threads,
    ].find((thread) => {
      return thread.id === otherFixture.threadId;
    });
    expect(victimRow?.title).not.toBe("Hijacked");

    // Given: the original caller's thread (auth restored).
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When: the caller renames their own thread.
    await accept(
      c.rename({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: { title: "Renamed" },
      }),
      [204],
    );

    // Then: the LIST endpoint shows the new title and renamedAt, and
    // Ably was published to once with `threadListChanged`.
    const afterList = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const renamedRow = [
      ...afterList.body.pinned,
      ...afterList.body.threads,
    ].find((thread) => {
      return thread.id === fixture.threadId;
    });
    expect(renamedRow?.title).toBe("Renamed");
    expect(renamedRow?.renamedAt).toBeTruthy();
    const firstRenamedAtMs = new Date(renamedRow!.renamedAt!).getTime();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    context.mocks.ably.publish.mockClear();

    // Given: the thread has been renamed once.
    // When: the caller renames it again (small delay to ensure a
    // strictly greater `renamedAt`).
    await delay(10, { signal: context.signal });

    await accept(
      c.rename({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: { title: "Second rename" },
      }),
      [204],
    );

    // Then: the LIST endpoint shows the second title with a fresher
    // `renamedAt`, and Ably was published to again.
    const afterSecond = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const secondRow = [
      ...afterSecond.body.pinned,
      ...afterSecond.body.threads,
    ].find((thread) => {
      return thread.id === fixture.threadId;
    });
    expect(secondRow?.title).toBe("Second rename");
    const secondRenamedAtMs = new Date(secondRow!.renamedAt!).getTime();
    expect(secondRenamedAtMs).toBeGreaterThan(firstRenamedAtMs);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
