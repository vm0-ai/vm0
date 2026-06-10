import { randomUUID } from "node:crypto";

import {
  chatThreadByIdContract,
  chatThreadModelSelectionContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../../services/zero-model-selection.service";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-chat-threads-model-selection.test.ts`.
// The legacy direct DB SELECTs that verified the persisted
// `selectedModel` column are replaced by assertions on the public
// detail contract's `selectedModel` field. The "victim row preserved"
// check is preserved by re-fetching the detail of the other user's
// thread (as the owner) and asserting selectedModel is still null.
// The 6 legacy `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function updateClient() {
  return setupApp({ context })(chatThreadModelSelectionContract);
}

function detailClient() {
  return setupApp({ context })(chatThreadByIdContract);
}

async function getDetail(threadId: string) {
  return await accept(
    detailClient().get({
      params: { id: threadId },
      headers: authHeaders(),
    }),
    [200],
  );
}

describe("BDD POST /api/zero/chat-threads/:id/model-selection — auth boundary", () => {
  it("returns 401 when unauthenticated and does not publish to Ably", async () => {
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401.
    const response = await accept(
      updateClient().update({
        params: { id: randomUUID() },
        headers: {},
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
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

describe("BDD POST /api/zero/chat-threads/:id/model-selection — selection chain", () => {
  it("gwt-wt-wt: 404 missing → 404 cross-user (victim selectedModel preserved) → 204 set (selectedModel updated + 1 publish) → 204 clears (selectedModel null + 1 publish) → 400 invalid model-first", async () => {
    const c = updateClient();
    context.mocks.ably.publish.mockClear();

    // Given: a fresh user/org with one chat thread.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 for an unknown thread id, no Ably publish.
    const missing = await accept(
      c.update({
        params: { id: randomUUID() },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [404],
    );
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: another user's thread in a different org.
    const otherFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId: `user_${randomUUID().slice(0, 8)}`,
          orgId: `org_${randomUUID().slice(0, 8)}`,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: cross-user update is 404 (no existence leak) and
    // the other user's thread still has a null selectedModel.
    const crossUser = await accept(
      c.update({
        params: { id: otherFixture.threadId },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [404],
    );
    expect(crossUser.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    const victim = await getDetail(otherFixture.threadId);
    expect(victim.body.selectedModel ?? null).toBeNull();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When: the owner sets a model-first selection.
    context.mocks.ably.publish.mockClear();
    const set = await accept(
      c.update({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [204],
    );
    expect(set.body).toBeUndefined();

    // Then: the public detail reports the new selectedModel and Ably
    // was published to once with `threadListChanged`.
    const setRow = await getDetail(fixture.threadId);
    expect(setRow.body.selectedModel).toBe("claude-sonnet-4-6");
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );

    // Given: the thread already has a non-null selectedModel (set
    // above). Public surface cannot produce a non-null prior value
    // for the clear-path test, so the only precondition is that the
    // thread currently has the value set by the previous step.
    context.mocks.ably.publish.mockClear();

    // When: the owner clears the selection by sending `null`.
    const cleared = await accept(
      c.update({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: { modelSelection: null },
      }),
      [204],
    );
    expect(cleared.body).toBeUndefined();

    // Then: the public detail reports a null selectedModel and Ably
    // was published to once more.
    const clearedRow = await getDetail(fixture.threadId);
    expect(clearedRow.body.selectedModel ?? null).toBeNull();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );

    // When + Then: an invalid model-first selection returns 400 and
    // does not publish.
    context.mocks.ably.publish.mockClear();
    const invalid = await accept(
      c.update({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "not-a-supported-model",
          },
        },
      }),
      [400],
    );
    expect(invalid.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
