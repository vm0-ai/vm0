import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../../services/zero-model-selection.service";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for chat-thread metadata mutations: pin, unpin,
// rename, and model-selection. Every precondition is a real HTTP request — an
// agent is created, then a thread on that agent — and every assertion reads the
// observable result back through the list/detail API (pinnedAt, title,
// renamedAt, selectedModel). No database seeding, no row assertions. See
// `api.bdd.md` (CHAIN-CHAT-THREAD-METADATA).
const context = testContext();

async function createThread(
  api: ReturnType<typeof createBddApi>,
): Promise<string> {
  const agent = await accept(
    api.agents.create({
      headers: SESSION_AUTH,
      body: { displayName: "Chat Agent", avatarUrl: "preset:1" },
    }),
    [201],
  );
  const created = await accept(
    api.chatThreads.create({
      headers: SESSION_AUTH,
      body: { agentId: agent.body.agentId, title: "Initial" },
    }),
    [201],
  );
  return created.body.id;
}

describe("chat thread metadata (API-first BDD)", () => {
  it("chain-chat-thread-metadata: pins, unpins, renames, and pins a model", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    // Given an agent and a chat thread on it.
    const threadId = await createThread(api);

    // Then the fresh thread is unpinned with its initial title.
    const initial = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(initial.body.pinned).toStrictEqual([]);
    expect(initial.body.threads.map((thread) => thread.id)).toStrictEqual([
      threadId,
    ]);
    expect(initial.body.threads[0]?.title).toBe("Initial");
    expect(initial.body.threads[0]?.pinnedAt ?? null).toBeNull();

    // When the thread is pinned. Then it moves to the pinned segment.
    await accept(
      api.chatThreadPin.pin({
        params: { id: threadId },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const afterPin = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterPin.body.pinned.map((thread) => thread.id)).toStrictEqual([
      threadId,
    ]);
    expect(afterPin.body.pinned[0]?.pinnedAt).toEqual(expect.any(String));
    expect(afterPin.body.threads).toStrictEqual([]);

    // When the thread is unpinned. Then it returns to the non-pinned segment.
    await accept(
      api.chatThreadUnpin.unpin({
        params: { id: threadId },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const afterUnpin = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterUnpin.body.pinned).toStrictEqual([]);
    expect(afterUnpin.body.threads.map((thread) => thread.id)).toStrictEqual([
      threadId,
    ]);
    expect(afterUnpin.body.threads[0]?.pinnedAt ?? null).toBeNull();

    // When the thread is renamed. Then the new title and renamedAt are visible.
    await accept(
      api.chatThreadRename.rename({
        params: { id: threadId },
        headers: SESSION_AUTH,
        body: { title: "Renamed Thread" },
      }),
      [204],
    );
    const afterRename = await accept(
      api.chatThreadById.get({
        params: { id: threadId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(afterRename.body.title).toBe("Renamed Thread");
    const renamedListed = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(renamedListed.body.threads[0]?.renamedAt).toEqual(
      expect.any(String),
    );

    // When a model is pinned. Then the detail reflects the selected model.
    await accept(
      api.chatThreadModelSelection.update({
        params: { id: threadId },
        headers: SESSION_AUTH,
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [204],
    );
    const withModel = await accept(
      api.chatThreadById.get({
        params: { id: threadId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(withModel.body.selectedModel).toBe("claude-sonnet-4-6");

    // When the model pin is cleared. Then the detail no longer carries a model.
    await accept(
      api.chatThreadModelSelection.update({
        params: { id: threadId },
        headers: SESSION_AUTH,
        body: { modelSelection: null },
      }),
      [204],
    );
    const cleared = await accept(
      api.chatThreadById.get({
        params: { id: threadId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(cleared.body.selectedModel ?? null).toBeNull();
  });

  it("isolates threads per user and validates metadata requests", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const orgId = `org_${randomUUID()}`;
    api.actAsAdmin({ orgId });

    // Given a thread owned by the first user.
    const threadId = await createThread(api);

    // A different user in the same org cannot see or mutate the thread.
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    await accept(
      api.chatThreadPin.pin({
        params: { id: threadId },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    await accept(
      api.chatThreadUnpin.unpin({
        params: { id: threadId },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    await accept(
      api.chatThreadRename.rename({
        params: { id: threadId },
        headers: SESSION_AUTH,
        body: { title: "Nope" },
      }),
      [404],
    );
    await accept(
      api.chatThreadModelSelection.update({
        params: { id: threadId },
        headers: SESSION_AUTH,
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [404],
    );

    // Unknown ids are not found for the owner either.
    api.actAsAdmin({ orgId });
    const unknown = randomUUID();
    await accept(
      api.chatThreadPin.pin({ params: { id: unknown }, headers: SESSION_AUTH }),
      [404],
    );
    await accept(
      api.chatThreadRename.rename({
        params: { id: unknown },
        headers: SESSION_AUTH,
        body: { title: "x" },
      }),
      [404],
    );

    // An empty rename title and an unsupported model are rejected.
    const emptyTitle = await accept(
      api.chatThreadRename.rename({
        params: { id: threadId },
        headers: SESSION_AUTH,
        body: { title: "" },
      }),
      [400],
    );
    expect(emptyTitle.body.error.code).toBe("BAD_REQUEST");
    const badModel = await accept(
      api.chatThreadModelSelection.update({
        params: { id: threadId },
        headers: SESSION_AUTH,
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "not-a-supported-model",
          },
        },
      }),
      [400],
    );
    expect(badModel.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects unauthenticated and organization-less metadata requests", async () => {
    const api = createBddApi(context);
    const id = randomUUID();

    // Unauthenticated requests on every metadata route.
    await accept(api.chatThreadPin.pin({ params: { id }, headers: {} }), [401]);
    await accept(
      api.chatThreadUnpin.unpin({ params: { id }, headers: {} }),
      [401],
    );
    await accept(
      api.chatThreadRename.rename({
        params: { id },
        headers: {},
        body: { title: "x" },
      }),
      [401],
    );
    await accept(
      api.chatThreadModelSelection.update({
        params: { id },
        headers: {},
        body: { modelSelection: null },
      }),
      [401],
    );

    // Model selection additionally requires an active organization.
    api.actAsNoOrg();
    await accept(
      api.chatThreadModelSelection.update({
        params: { id },
        headers: SESSION_AUTH,
        body: { modelSelection: null },
      }),
      [401],
    );
  });
});
