import { describe, expect, it } from "vitest";
import { createIdbMessageStores } from "../idb-message-store";

function makeMsg(
  id: string,
  threadId: string,
  createdAt: string,
  content?: string,
) {
  return {
    id,
    role: "user" as const,
    content: content ?? `msg ${id}`,
    createdAt,
    threadId,
  };
}

const THREAD = "thread-1";
const USER = "test-user";
const ORG = "test-org";

describe("idb-message-store", () => {
  it("upserts and reads latest messages", async () => {
    const { readStore: readStore$, writeStore: writeStore$ } =
      createIdbMessageStores(USER, ORG);
    const writeStore = writeStore$;
    const readStore = readStore$;

    await writeStore.upsertMessages(THREAD, [
      makeMsg("m1", THREAD, "2026-01-01T00:00:00Z"),
      makeMsg("m2", THREAD, "2026-01-02T00:00:00Z"),
    ]);

    const latest = await readStore.readLatest(THREAD, 10);
    expect(latest).toHaveLength(2);
    expect(latest[0].id).toBe("m1");
    expect(latest[1].id).toBe("m2");
  });

  it("readLatest respects limit", async () => {
    const { readStore: readStore$, writeStore: writeStore$ } =
      createIdbMessageStores(USER + "-limit", ORG);
    const writeStore = writeStore$;
    const readStore = readStore$;

    await writeStore.upsertMessages(THREAD, [
      makeMsg("a1", THREAD, "2026-01-01T00:00:00Z"),
      makeMsg("a2", THREAD, "2026-01-02T00:00:00Z"),
      makeMsg("a3", THREAD, "2026-01-03T00:00:00Z"),
    ]);

    const latest = await readStore.readLatest(THREAD, 2);
    expect(latest).toHaveLength(2);
    // Should return the 2 most recent (reversed from cursor order)
    expect(latest[0].id).toBe("a2");
    expect(latest[1].id).toBe("a3");
  });

  it("readBefore paginates before an anchor", async () => {
    const { readStore: readStore$, writeStore: writeStore$ } =
      createIdbMessageStores(USER + "-before", ORG);
    const writeStore = writeStore$;
    const readStore = readStore$;

    const messages = [
      makeMsg("b1", THREAD, "2026-02-01T00:00:00Z"),
      makeMsg("b2", THREAD, "2026-02-02T00:00:00Z"),
      makeMsg("b3", THREAD, "2026-02-03T00:00:00Z"),
      makeMsg("b4", THREAD, "2026-02-04T00:00:00Z"),
    ];
    await writeStore.upsertMessages(THREAD, messages);

    // Read before b3 (exclusive) — should get b1 and b2
    const before = await readStore.readBefore(THREAD, "b3", 10);
    expect(before).toHaveLength(2);
    expect(before[0].id).toBe("b1");
    expect(before[1].id).toBe("b2");
  });

  it("readBefore skips anchor row when messages share createdAt", async () => {
    const { readStore: readStore$, writeStore: writeStore$ } =
      createIdbMessageStores(USER + "-same-time", ORG);
    const writeStore = writeStore$;
    const readStore = readStore$;

    // Multiple messages with the same createdAt — P1 fix ensures correct skip
    const messages = [
      makeMsg("c1", THREAD, "2026-03-01T00:00:00Z"),
      makeMsg("c2", THREAD, "2026-03-01T00:00:00Z"),
      makeMsg("c3", THREAD, "2026-03-01T00:00:00Z"),
    ];
    await writeStore.upsertMessages(THREAD, messages);

    const before = await readStore.readBefore(THREAD, "c2", 10);
    expect(before).toHaveLength(1);
    expect(before[0].id).toBe("c1");
  });

  it("rejects invalid data from IDB", async () => {
    const { readStore: readStore$, writeStore: writeStore$ } =
      createIdbMessageStores(USER + "-invalid", ORG);
    const writeStore = writeStore$;

    // Initialize the DB with a valid write first so the store exists
    await writeStore.upsertMessages(THREAD, [
      makeMsg("valid-1", THREAD, "2026-05-01T00:00:00Z"),
    ]);

    // Write a malformed row directly via the raw store (bypassing type safety)
    const { openDB } = await import("idb");
    const db = await openDB(`vm0-chat-${USER}-invalid-${ORG}`, 2);
    // Put an object with threadId so it matches the index, but missing required
    // fields (role) so schema validation rejects it
    await db.put("chat_messages", {
      id: "bad-1",
      threadId: THREAD,
      createdAt: "2026-05-02T00:00:00Z",
      // missing role, content
    });

    // Reading should fail on schema validation
    const readStore = readStore$;

    await expect(readStore.readLatest(THREAD, 10)).rejects.toThrow();
  });

  it("messageExists returns true when message exists with matching threadId", async () => {
    const { readStore, writeStore } = createIdbMessageStores(
      USER + "-exists",
      ORG,
    );

    await writeStore.upsertMessages(THREAD, [
      makeMsg("e1", THREAD, "2026-05-01T00:00:00Z"),
    ]);

    const exists = await readStore.messageExists(THREAD, "e1");
    expect(exists).toBeTruthy();
  });

  it("messageExists returns false when message does not exist", async () => {
    const { readStore, writeStore } = createIdbMessageStores(
      USER + "-notfound",
      ORG,
    );

    await writeStore.upsertMessages(THREAD, [
      makeMsg("f1", THREAD, "2026-05-01T00:00:00Z"),
    ]);

    const exists = await readStore.messageExists(THREAD, "nonexistent");
    expect(exists).toBeFalsy();
  });

  it("messageExists returns false when message exists but threadId differs", async () => {
    const { readStore, writeStore } = createIdbMessageStores(
      USER + "-wrongthread",
      ORG,
    );

    await writeStore.upsertMessages(THREAD, [
      makeMsg("g1", THREAD, "2026-05-01T00:00:00Z"),
    ]);

    const exists = await readStore.messageExists("other-thread", "g1");
    expect(exists).toBeFalsy();
  });

  it("scopes messages by user and org", async () => {
    const storesA = createIdbMessageStores("user-a", "org-a");
    const storesB = createIdbMessageStores("user-b", "org-b");

    await storesA.writeStore.upsertMessages(THREAD, [
      makeMsg("da1", THREAD, "2026-04-01T00:00:00Z"),
    ]);
    await storesB.writeStore.upsertMessages(THREAD, [
      makeMsg("db1", THREAD, "2026-04-01T00:00:00Z"),
    ]);

    const msgsA = await storesA.readStore.readLatest(THREAD, 10);
    const msgsB = await storesB.readStore.readLatest(THREAD, 10);

    expect(msgsA).toHaveLength(1);
    expect(msgsA[0].id).toBe("da1");
    expect(msgsB).toHaveLength(1);
    expect(msgsB[0].id).toBe("db1");
  });
});
