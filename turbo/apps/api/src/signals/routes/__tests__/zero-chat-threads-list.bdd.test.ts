import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the chat-thread list endpoint: unified + agentId
// scoping, pinned/non-pinned segmentation, cursor pagination, and the per-row
// metadata fields (pinnedAt, renamedAt, hasDraft) that are reachable without a
// run or a seeded message. Threads and agents are all created through the
// public API. The run/message/schedule-derived row values (running, isRead by
// cursor, scheduleCount) are SQL-computed columns with no unique JS branch, so
// the legacy value cases were dropped (DROP-CHAT-LIST-SQL-VALUES) without any
// coverage loss. See `api.bdd.md` (CHAIN-CHAT-THREAD-LIST).
const context = testContext();

async function createAgent(
  api: ReturnType<typeof createBddApi>,
  displayName = "Chat Agent",
): Promise<string> {
  const agent = await accept(
    api.agents.create({
      headers: SESSION_AUTH,
      body: { displayName, avatarUrl: "preset:1" },
    }),
    [201],
  );
  return agent.body.agentId;
}

async function createThread(
  api: ReturnType<typeof createBddApi>,
  agentId: string,
  title: string,
): Promise<string> {
  const created = await accept(
    api.chatThreads.create({
      headers: SESSION_AUTH,
      body: { agentId, title },
    }),
    [201],
  );
  return created.body.id;
}

describe("chat thread list (API-first BDD)", () => {
  it("chain-chat-thread-list: lists rows, segments pinned, and reflects rename + draft", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    const agentId = await createAgent(api);
    const a = await createThread(api, agentId, "A");
    const b = await createThread(api, agentId, "B");
    const c = await createThread(api, agentId, "C");

    // Then the unified list returns every owned thread with its metadata.
    const all = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(all.body.pinned).toStrictEqual([]);
    expect(new Set(all.body.threads.map((thread) => thread.id))).toStrictEqual(
      new Set([a, b, c]),
    );
    expect(all.body.hasMore).toBeFalsy();
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.totalCount).toBe(3);
    const itemC = all.body.threads.find((thread) => thread.id === c);
    expect(itemC).toMatchObject({
      title: "C",
      isRead: true,
      running: false,
    });
    expect(itemC?.agent.id).toBe(agentId);
    expect(itemC?.agent).toHaveProperty("avatarUrl");
    expect(itemC?.createdAt).toEqual(expect.any(String));
    expect(itemC?.updatedAt).toEqual(expect.any(String));
    expect(itemC?.pinnedAt ?? null).toBeNull();
    expect(itemC?.renamedAt ?? null).toBeNull();
    expect(itemC?.hasDraft ?? false).toBeFalsy();

    // When a thread is pinned. Then it floats into the pinned segment.
    await accept(
      api.chatThreadPin.pin({ params: { id: a }, headers: SESSION_AUTH }),
      [204],
    );
    const pinned = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(pinned.body.pinned.map((thread) => thread.id)).toStrictEqual([a]);
    expect(pinned.body.pinned[0]?.pinnedAt).toEqual(expect.any(String));
    expect(
      new Set(pinned.body.threads.map((thread) => thread.id)),
    ).toStrictEqual(new Set([b, c]));

    // When a thread is renamed. Then its row carries the new title + renamedAt.
    await accept(
      api.chatThreadRename.rename({
        params: { id: b },
        headers: SESSION_AUTH,
        body: { title: "B renamed" },
      }),
      [204],
    );
    const renamed = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    const itemB = renamed.body.threads.find((thread) => thread.id === b);
    expect(itemB?.title).toBe("B renamed");
    expect(itemB?.renamedAt).toEqual(expect.any(String));

    // When a draft is saved. Then the row reports hasDraft.
    await accept(
      api.chatThreadById.patch({
        params: { id: c },
        headers: SESSION_AUTH,
        body: { draftContent: "wip" },
      }),
      [204],
    );
    const drafted = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      drafted.body.threads.find((thread) => thread.id === c)?.hasDraft,
    ).toBeTruthy();
  });

  it("paginates the non-pinned segment and keeps pinned on the first page only", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    const agentId = await createAgent(api);
    const ids: string[] = [];
    for (const title of ["T0", "T1", "T2"]) {
      ids.push(await createThread(api, agentId, title));
    }
    // Pin the first thread so the non-pinned segment has two rows to page over.
    await accept(
      api.chatThreadPin.pin({ params: { id: ids[0]! }, headers: SESSION_AUTH }),
      [204],
    );

    // First page (limit 1 over two non-pinned) overflows and carries pinned.
    const page1 = await accept(
      api.chatThreads.list({ query: { limit: 1 }, headers: SESSION_AUTH }),
      [200],
    );
    expect(page1.body.pinned.map((thread) => thread.id)).toStrictEqual([
      ids[0],
    ]);
    expect(page1.body.threads).toHaveLength(1);
    expect(page1.body.hasMore).toBeTruthy();
    expect(page1.body.nextCursor).not.toBeNull();
    expect(page1.body.totalCount).toBe(2);

    // Second page (via cursor) returns the remainder with no pinned segment.
    const page2 = await accept(
      api.chatThreads.list({
        query: { limit: 1, cursor: page1.body.nextCursor! },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(page2.body.pinned).toStrictEqual([]);
    expect(page2.body.threads).toHaveLength(1);
    expect(page2.body.hasMore).toBeFalsy();
    expect(page2.body.nextCursor).toBeNull();
    expect(
      new Set([
        ...page1.body.threads.map((thread) => thread.id),
        ...page2.body.threads.map((thread) => thread.id),
      ]),
    ).toStrictEqual(new Set([ids[1], ids[2]]));

    // A malformed cursor is treated as the first page (pinned returns).
    const garbled = await accept(
      api.chatThreads.list({
        query: { cursor: "not-a-valid-cursor" },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(garbled.body.pinned.map((thread) => thread.id)).toStrictEqual([
      ids[0],
    ]);
  });

  it("scopes by agentId, isolates orgs, and rejects unauthenticated / no-org", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const orgId = `org_${randomUUID()}`;
    api.actAsAdmin({ orgId });

    const agent1 = await createAgent(api, "Agent One");
    const agent2 = await createAgent(api, "Agent Two");
    const t1 = await createThread(api, agent1, "one");
    await createThread(api, agent2, "two");

    // Scoped to one agent returns only that agent's threads.
    const scoped = await accept(
      api.chatThreads.list({
        query: { agentId: agent1 },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(scoped.body.threads.map((thread) => thread.id)).toStrictEqual([t1]);
    expect(scoped.body.threads[0]?.agent.id).toBe(agent1);

    // An unknown agent is not found.
    await accept(
      api.chatThreads.list({
        query: { agentId: randomUUID() },
        headers: SESSION_AUTH,
      }),
      [404],
    );

    // Another org sees no threads and cannot scope to the first org's agent.
    api.actAsAdmin({ orgId: `org_${randomUUID()}` });
    const otherOrg = await accept(
      api.chatThreads.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(otherOrg.body.threads).toStrictEqual([]);
    expect(otherOrg.body.pinned).toStrictEqual([]);
    await accept(
      api.chatThreads.list({
        query: { agentId: agent1 },
        headers: SESSION_AUTH,
      }),
      [404],
    );

    // No active organization is unauthorized.
    api.actAsNoOrg();
    await accept(api.chatThreads.list({ headers: SESSION_AUTH }), [401]);

    // Unauthenticated is unauthorized.
    await accept(api.chatThreads.list({ headers: {} }), [401]);
  });
});
