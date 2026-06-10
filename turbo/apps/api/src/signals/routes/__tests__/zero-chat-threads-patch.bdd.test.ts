import { randomUUID } from "node:crypto";

import {
  chatThreadByIdContract,
  chatThreadsContract,
  type PersistedAttachment,
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

// BDD migration of the legacy `zero-chat-threads-patch.test.ts`. The
// legacy direct DB SELECTs that verified `draftContent` and
// `draftAttachments` are replaced by assertions on the public list
// endpoint's `hasDraft` boolean (which is exactly the public signal the
// sidebar uses to render the draft indicator). The victim-row
// preservation check is verified by re-authenticating as the owner and
// inspecting the list (their draft is unchanged). The 12 legacy
// `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function patchClient() {
  return setupApp({ context })(chatThreadByIdContract);
}

function listClient() {
  return setupApp({ context })(chatThreadsContract);
}

async function findRow(threadId: string) {
  const list = await accept(
    listClient().list({ headers: authHeaders() }),
    [200],
  );
  return [...list.body.pinned, ...list.body.threads].find((entry) => {
    return entry.id === threadId;
  });
}

describe("BDD PATCH /api/zero/chat-threads/:id — auth boundary", () => {
  it("returns 401 when unauthenticated and does not publish to Ably", async () => {
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401.
    const response = await accept(
      patchClient().patch({
        params: { id: randomUUID() },
        body: { draftContent: "hello" },
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

describe("BDD PATCH /api/zero/chat-threads/:id — draft transition chain", () => {
  it("gwt-wt-wt: 404 missing → 404 cross-user (owner draft preserved) → 204 sets draft (hasDraft: true, 1 publish) → 204 continues draft (no publish) → 204 clears (hasDraft: false, 1 publish) → 204 empty-over-empty (no publish) → 204 attachments-only (hasDraft: true, 1 publish)", async () => {
    context.mocks.ably.publish.mockClear();
    const c = patchClient();

    // Given: a fresh user/org with one chat thread.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: patch on an unknown thread returns 404 and does
    // not publish.
    const missing = await accept(
      c.patch({
        params: { id: randomUUID() },
        body: { draftContent: "hello" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: the owner has a draft on the thread; a different user in
    // the same org tries to overwrite it.
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await accept(
      c.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "owner content" },
        headers: authHeaders(),
      }),
      [204],
    );
    context.mocks.ably.publish.mockClear();
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, fixture.orgId);

    // When + Then: cross-user patch returns 404 (no existence leak),
    // does not publish, and the owner's draft is preserved.
    const crossUser = await accept(
      c.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "unauthorized" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Re-authenticate as the owner and confirm the list still shows
    // `hasDraft: true` with the owner's draft intact.
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const ownerRow = await findRow(fixture.threadId);
    expect(ownerRow?.hasDraft).toBeTruthy();
    context.mocks.ably.publish.mockClear();

    // Given: the thread now has a draft (set above).
    // When: the owner re-patches with a fresh non-empty draft.
    // (Clear first so the next patch is a transition — false → true.)
    await accept(
      c.patch({
        params: { id: fixture.threadId },
        body: { draftContent: null },
        headers: authHeaders(),
      }),
      [204],
    );
    const clearedRow = await findRow(fixture.threadId);
    expect(clearedRow?.hasDraft).toBeFalsy();
    context.mocks.ably.publish.mockClear();

    // When: the owner writes a non-empty draft (transition false → true).
    await accept(
      c.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "first keystroke" },
        headers: authHeaders(),
      }),
      [204],
    );

    // Then: the list shows `hasDraft: true` and Ably was published to
    // once with `threadListChanged`.
    const draftedRow = await findRow(fixture.threadId);
    expect(draftedRow?.hasDraft).toBeTruthy();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    context.mocks.ably.publish.mockClear();

    // When: the owner continues typing (no transition — both calls have
    // a draft, so no publish).
    await accept(
      c.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "hi there" },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    const stillDraftedRow = await findRow(fixture.threadId);
    expect(stillDraftedRow?.hasDraft).toBeTruthy();

    // When: the owner clears the draft (transition true → false).
    await accept(
      c.patch({
        params: { id: fixture.threadId },
        body: { draftContent: null },
        headers: authHeaders(),
      }),
      [204],
    );

    // Then: the list shows `hasDraft: false` and Ably published again.
    const clearedAgainRow = await findRow(fixture.threadId);
    expect(clearedAgainRow?.hasDraft).toBeFalsy();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    context.mocks.ably.publish.mockClear();

    // When: the owner patches empty over empty (no transition).
    await accept(
      c.patch({
        params: { id: fixture.threadId },
        body: { draftContent: null },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // When: the owner adds attachments only (transition false → true).
    const attachments: PersistedAttachment[] = [
      {
        id: "att-only",
        url: "https://example.com/file.txt",
        filename: "file.txt",
        contentType: "text/plain",
        size: 100,
      },
    ];
    await accept(
      c.patch({
        params: { id: fixture.threadId },
        body: { draftContent: null, draftAttachments: attachments },
        headers: authHeaders(),
      }),
      [204],
    );

    // Then: the list shows `hasDraft: true` and Ably published again.
    const attachmentsRow = await findRow(fixture.threadId);
    expect(attachmentsRow?.hasDraft).toBeTruthy();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
