import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for chat-thread creation and draft patching. Threads
// are opened on agents created through the public API; the draft is read back
// through the thread detail (draftContent / draftAttachments). No DB seeding,
// no row assertions. See `api.bdd.md` (CHAIN-CHAT-THREAD-CREATE-PATCH).
const context = testContext();

async function createAgent(
  api: ReturnType<typeof createBddApi>,
): Promise<string> {
  const agent = await accept(
    api.agents.create({
      headers: SESSION_AUTH,
      body: { displayName: "Chat Agent", avatarUrl: "preset:1" },
    }),
    [201],
  );
  return agent.body.agentId;
}

describe("chat thread create + draft patch (API-first BDD)", () => {
  it("chain-chat-thread-create: creates with a title, honours a client id, then drafts", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    // Given an agent.
    const agentId = await createAgent(api);

    // When a thread is created with a title. Then it carries that title.
    const titled = await accept(
      api.chatThreads.create({
        headers: SESSION_AUTH,
        body: { agentId, title: "My thread" },
      }),
      [201],
    );
    expect(titled.body.title).toBe("My thread");
    expect(titled.body.id).toStrictEqual(expect.any(String));
    expect(titled.body.createdAt).toStrictEqual(expect.any(String));

    // When a thread is created with a client id and no title. Then the row id
    // is the client id and the title is null.
    const clientThreadId = randomUUID();
    const clientCreated = await accept(
      api.chatThreads.create({
        headers: SESSION_AUTH,
        body: { agentId, clientThreadId },
      }),
      [201],
    );
    expect(clientCreated.body.id).toBe(clientThreadId);
    expect(clientCreated.body.title).toBeNull();

    // Then both threads are listed for the owner.
    const listed = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      new Set(
        listed.body.threads.map((thread) => {
          return thread.id;
        }),
      ),
    ).toStrictEqual(new Set([titled.body.id, clientThreadId]));

    // When a draft (content + attachment) is saved. Then the detail reflects it.
    const attachments = [
      {
        id: "att-1",
        url: "https://example.com/file.txt",
        filename: "file.txt",
        contentType: "text/plain",
        size: 100,
      },
    ];
    await accept(
      api.chatThreadById.patch({
        params: { id: titled.body.id },
        headers: SESSION_AUTH,
        body: {
          draftContent: "with attachment",
          draftAttachments: attachments,
        },
      }),
      [204],
    );
    const drafted = await accept(
      api.chatThreadById.get({
        params: { id: titled.body.id },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(drafted.body.draftContent).toBe("with attachment");
    expect(drafted.body.draftAttachments).toStrictEqual(attachments);

    // When the draft is replaced while still non-empty (no presence
    // transition). Then the new content shows and the attachment is dropped.
    await accept(
      api.chatThreadById.patch({
        params: { id: titled.body.id },
        headers: SESSION_AUTH,
        body: { draftContent: "edited draft" },
      }),
      [204],
    );
    const edited = await accept(
      api.chatThreadById.get({
        params: { id: titled.body.id },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(edited.body.draftContent).toBe("edited draft");
    expect(edited.body.draftAttachments ?? null).toBeNull();

    // When the draft is cleared. Then the detail no longer carries it.
    await accept(
      api.chatThreadById.patch({
        params: { id: titled.body.id },
        headers: SESSION_AUTH,
        body: { draftContent: null, draftAttachments: null },
      }),
      [204],
    );
    const cleared = await accept(
      api.chatThreadById.get({
        params: { id: titled.body.id },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(cleared.body.draftContent ?? null).toBeNull();
    expect(cleared.body.draftAttachments ?? null).toBeNull();
  });

  it("rejects creates against missing or cross-org agents and isolates drafts", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();

    // A non-existent agent is not found.
    api.actAsAdmin();
    await accept(
      api.chatThreads.create({
        headers: SESSION_AUTH,
        body: { agentId: randomUUID(), title: "x" },
      }),
      [404],
    );

    // An agent created in one org is invisible to another org.
    const ownerOrg = `org_${randomUUID()}`;
    const owner = api.actAsAdmin({ orgId: ownerOrg });
    const agentId = await createAgent(api);
    const owned = await accept(
      api.chatThreads.create({
        headers: SESSION_AUTH,
        body: { agentId, title: "Owned" },
      }),
      [201],
    );

    api.actAsAdmin({ orgId: `org_${randomUUID()}` });
    await accept(
      api.chatThreads.create({
        headers: SESSION_AUTH,
        body: { agentId, title: "Hijacked" },
      }),
      [404],
    );

    // A different user in the owner org cannot read or patch the owner's draft.
    api.actAsAdmin({ userId: owner.userId, orgId: ownerOrg });
    await accept(
      api.chatThreadById.patch({
        params: { id: owned.body.id },
        headers: SESSION_AUTH,
        body: { draftContent: "owner content" },
      }),
      [204],
    );
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId: ownerOrg });
    await accept(
      api.chatThreadById.patch({
        params: { id: owned.body.id },
        headers: SESSION_AUTH,
        body: { draftContent: "unauthorized" },
      }),
      [404],
    );

    // The owner's draft is preserved.
    api.actAsAdmin({ userId: owner.userId, orgId: ownerOrg });
    const ownerDetail = await accept(
      api.chatThreadById.get({
        params: { id: owned.body.id },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(ownerDetail.body.draftContent).toBe("owner content");
  });

  it("rejects unauthenticated create, patch, and organization-less create", async () => {
    const api = createBddApi(context);
    const id = randomUUID();

    await accept(
      api.chatThreads.create({
        headers: {},
        body: { agentId: randomUUID(), title: "x" },
      }),
      [401],
    );
    await accept(
      api.chatThreadById.patch({
        params: { id },
        headers: {},
        body: { draftContent: "x" },
      }),
      [401],
    );

    // A session with no active organization cannot resolve any agent, so create
    // is not found rather than unauthorized.
    api.actAsNoOrg();
    await accept(
      api.chatThreads.create({
        headers: SESSION_AUTH,
        body: { agentId: randomUUID(), title: "x" },
      }),
      [404],
    );
  });
});
