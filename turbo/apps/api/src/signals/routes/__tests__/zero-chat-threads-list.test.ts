import { randomUUID } from "node:crypto";

import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { nowDate } from "../../external/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteZeroChatThread$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import { seedRun$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

async function setLastReadMessageId(
  threadId: string,
  messageId: string | null,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .update(chatThreads)
    .set({ lastReadMessageId: messageId })
    .where(eq(chatThreads.id, threadId));
}

describe("GET /api/zero/chat-threads (list with optional agentId scoping)", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 for compose from a different org when scoped via agentId", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    // A second thread/compose in a different org.
    const otherFixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: otherFixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns empty array when no threads exist", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toStrictEqual([]);
  });

  it("lists created threads with id, createdAt, updatedAt fields populated", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Listed thread" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    const thread = response.body.threads[0]!;
    expect(thread.id).toBe(fixture.threadId);
    expect(thread.title).toBe("Listed thread");
    expect(typeof thread.createdAt).toBe("string");
    expect(typeof thread.updatedAt).toBe("string");
  });

  it("reports isRead=true and isArchived=false for a thread with no messages", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "Empty" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    expect(response.body.threads[0]!.isRead).toBeTruthy();
    expect(response.body.threads[0]!.isArchived).toBeFalsy();
  });

  it("reports isRead based on last_read_message_id", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;

    const readFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Read" },
        context.signal,
      ),
    );
    const readMsgId = await store.set(
      seedZeroChatMessage$,
      readFixture,
      { role: "assistant", content: "hi" },
      context.signal,
    );
    await setLastReadMessageId(readFixture.threadId, readMsgId);

    const unreadFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Unread" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      unreadFixture,
      { role: "assistant", content: "hi" },
      context.signal,
    );

    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const readRow = response.body.threads.find((t) => {
      return t.id === readFixture.threadId;
    });
    const unreadRow = response.body.threads.find((t) => {
      return t.id === unreadFixture.threadId;
    });
    expect(readRow?.isRead).toBeTruthy();
    expect(unreadRow?.isRead).toBeFalsy();
  });

  it("filters out threads whose last message is archived", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;

    const archivedFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Archived" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      archivedFixture,
      { role: "assistant", content: "gone", archivedAt: nowDate() },
      context.signal,
    );

    const liveFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Live" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      liveFixture,
      { role: "assistant", content: "still here" },
      context.signal,
    );

    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const ids = response.body.threads.map((t) => {
      return t.id;
    });
    expect(ids).toContain(liveFixture.threadId);
    expect(ids).not.toContain(archivedFixture.threadId);
  });

  it("orders threads by the latest message's createdAt desc", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;

    const olderFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Older" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      olderFixture,
      {
        role: "user",
        content: "first",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      context.signal,
    );

    const newerFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Newer" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      newerFixture,
      {
        role: "user",
        content: "second",
        createdAt: new Date("2025-01-02T00:00:00.000Z"),
      },
      context.signal,
    );

    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const initial = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      initial.body.threads.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([newerFixture.threadId, olderFixture.threadId]);

    // A newer message on the older thread should bump it to the top.
    await store.set(
      seedZeroChatMessage$,
      olderFixture,
      {
        role: "assistant",
        content: "reply",
        createdAt: new Date("2025-01-03T00:00:00.000Z"),
      },
      context.signal,
    );

    const after = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      after.body.threads.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([olderFixture.threadId, newerFixture.threadId]);
  });

  it("orders empty threads by their own createdAt desc", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;

    const firstFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "First",
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const secondFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "Second",
          createdAt: new Date("2025-01-02T00:00:00.000Z"),
        },
        context.signal,
      ),
    );

    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      response.body.threads.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([secondFixture.threadId, firstFixture.threadId]);
  });

  it("floats pinned threads to the top regardless of recency", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;

    const firstFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "First",
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const secondFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "Second",
          createdAt: new Date("2025-01-02T00:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const thirdFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "Third",
          createdAt: new Date("2025-01-03T00:00:00.000Z"),
        },
        context.signal,
      ),
    );

    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const baseline = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      baseline.body.threads.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([
      thirdFixture.threadId,
      secondFixture.threadId,
      firstFixture.threadId,
    ]);

    // Pin the middle one — it should jump to the top.
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(chatThreads)
      .set({ pinnedAt: nowDate() })
      .where(eq(chatThreads.id, secondFixture.threadId));

    const afterPin = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      afterPin.body.threads.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([
      secondFixture.threadId,
      thirdFixture.threadId,
      firstFixture.threadId,
    ]);
    const pinnedRow = afterPin.body.threads.find((t) => {
      return t.id === secondFixture.threadId;
    });
    expect(typeof pinnedRow?.pinnedAt).toBe("string");

    // Unpin returns the order to recency-based.
    await writeDb
      .update(chatThreads)
      .set({ pinnedAt: null })
      .where(eq(chatThreads.id, secondFixture.threadId));

    const afterUnpin = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      afterUnpin.body.threads.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([
      thirdFixture.threadId,
      secondFixture.threadId,
      firstFixture.threadId,
    ]);
    const unpinnedRow = afterUnpin.body.threads.find((t) => {
      return t.id === secondFixture.threadId;
    });
    expect(unpinnedRow?.pinnedAt).toBeNull();
  });

  it("keeps a thread visible when only an earlier message is archived", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "Mixed" }, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "first",
        archivedAt: nowDate(),
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "second",
        createdAt: new Date("2025-01-02T00:00:00.000Z"),
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    expect(response.body.threads[0]!.id).toBe(fixture.threadId);
    expect(response.body.threads[0]!.isArchived).toBeFalsy();
  });

  it("reports running=false for a thread with no runs", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "No runs" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads[0]!.running).toBeFalsy();
  });

  it("reports running=true when a run is non-terminal", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "Running" }, context.signal),
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "running",
        chatThreadId: fixture.threadId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads[0]!.running).toBeTruthy();
  });

  it("returns agent.id and agent.avatarUrl for scoped (agentId query) requests", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "Scoped agent" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    expect(response.body.threads[0]!.agent.id).toBe(fixture.composeId);
    expect(response.body.threads[0]!.agent).toHaveProperty("avatarUrl");
  });

  it("reports running=false when all runs reach terminal states", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "Completed" }, context.signal),
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "completed",
        chatThreadId: fixture.threadId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads[0]!.running).toBeFalsy();
  });

  it("reports hasDraft=false for a thread without draft content", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "No draft" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads[0]!.hasDraft).toBeFalsy();
  });

  it("reports hasDraft=true when draftContent is non-empty", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "With draft", draftContent: "unsent text" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads[0]!.hasDraft).toBeTruthy();
  });

  it("reports hasDraft=true when only draftAttachments are set", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          title: "Only files",
          draftAttachments: [
            {
              id: randomUUID(),
              url: "https://example.com/f/file.png",
              filename: "file.png",
              contentType: "image/png",
              size: 100,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads[0]!.hasDraft).toBeTruthy();
  });

  it("reports hasDraft=false when draftContent is empty string", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Empty", draftContent: "" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads[0]!.hasDraft).toBeFalsy();
  });

  it("reports running=true when any run is non-terminal even with a terminal sibling", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "Mixed runs" }, context.signal),
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "completed",
        chatThreadId: fixture.threadId,
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "queued",
        chatThreadId: fixture.threadId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: { agentId: fixture.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads[0]!.running).toBeTruthy();
  });

  it("returns pinnedAt and renamedAt as ISO strings when set", async () => {
    const pinnedDate = new Date("2025-05-01T10:00:00.000Z");
    const renamedDate = new Date("2025-06-01T12:00:00.000Z");
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          title: "Pinned & Renamed",
          pinnedAt: pinnedDate,
          renamedAt: renamedDate,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    expect(response.body.threads[0]!.pinnedAt).toBe("2025-05-01T10:00:00.000Z");
    expect(response.body.threads[0]!.renamedAt).toBe(
      "2025-06-01T12:00:00.000Z",
    );
  });

  it("returns pinnedAt and renamedAt as null when not set", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    expect(response.body.threads[0]!.pinnedAt).toBeNull();
    expect(response.body.threads[0]!.renamedAt).toBeNull();
  });

  it("returns pinned threads before unpinned threads", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const pinned = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "Pinned Thread",
          pinnedAt: new Date("2025-05-01T10:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const unpinned = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Unpinned Thread" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      pinned,
      {
        role: "user",
        content: "msg",
        createdAt: new Date("2025-05-01T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      unpinned,
      {
        role: "user",
        content: "msg",
        createdAt: new Date("2025-05-02T00:00:00.000Z"),
      },
      context.signal,
    );

    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(2);
    expect(response.body.threads[0]!.id).toBe(pinned.threadId);
    expect(response.body.threads[1]!.id).toBe(unpinned.threadId);
  });
});

describe("GET /api/zero/chat-threads (unified list, agentId omitted)", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns threads for every agent in the caller's org", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const a = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "A thread" },
        context.signal,
      ),
    );
    const b = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "B thread" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const ids = response.body.threads.map((t) => {
      return t.id;
    });
    expect(ids).toContain(a.threadId);
    expect(ids).toContain(b.threadId);
  });

  it("returns agent.id and agent.avatarUrl for every row", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "A" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    expect(response.body.threads[0]!.agent.id).toBe(fixture.composeId);
    expect(response.body.threads[0]!.agent).toHaveProperty("avatarUrl");
  });

  it("does not leak threads from another org", async () => {
    const userId = `user_${randomUUID()}`;
    const myOrgId = `org_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;
    const mine = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId: myOrgId, title: "Mine" },
        context.signal,
      ),
    );
    const others = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId: otherOrgId, title: "Other" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, myOrgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const ids = response.body.threads.map((t) => {
      return t.id;
    });
    expect(ids).toContain(mine.threadId);
    expect(ids).not.toContain(others.threadId);
  });
});
