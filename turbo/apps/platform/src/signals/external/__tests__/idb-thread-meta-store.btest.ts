import { describe, expect, it } from "vitest";
import { patchThreadMeta$, readThreadMeta$ } from "../idb-thread-meta-store";
import { createIdbMessageStores } from "../idb-message-store";

const USER = "test-user";
const ORG = "test-org";

describe("idb-thread-meta-store", () => {
  it("write then read returns the cached agentId", async () => {
    await patchThreadMeta$(USER + "-rw", ORG, "thread-rw", {
      agentId: "agent-rw",
    });
    const got = await readThreadMeta$(USER + "-rw", ORG, "thread-rw");
    expect(got?.agentId).toBe("agent-rw");
    expect(got?.startMessageId).toBeNull();
  });

  it("read on missing key returns null", async () => {
    const got = await readThreadMeta$(USER + "-miss", ORG, "thread-missing");
    expect(got).toBeNull();
  });

  it("patch preserves fields not provided", async () => {
    await patchThreadMeta$(USER + "-merge", ORG, "thread-merge", {
      agentId: "agent-merge",
    });
    await patchThreadMeta$(USER + "-merge", ORG, "thread-merge", {
      startMessageId: "msg-start",
    });
    const got = await readThreadMeta$(USER + "-merge", ORG, "thread-merge");
    expect(got?.agentId).toBe("agent-merge");
    expect(got?.startMessageId).toBe("msg-start");
  });

  it("patch overwrites a previously set field", async () => {
    await patchThreadMeta$(USER + "-update", ORG, "thread-update", {
      agentId: "agent-1",
    });
    await patchThreadMeta$(USER + "-update", ORG, "thread-update", {
      agentId: "agent-2",
    });
    const got = await readThreadMeta$(USER + "-update", ORG, "thread-update");
    expect(got?.agentId).toBe("agent-2");
  });

  it("scopes rows by (userId, orgId)", async () => {
    await patchThreadMeta$("user-a", "org-a", "shared-thread", {
      agentId: "agent-a",
    });
    await patchThreadMeta$("user-b", "org-b", "shared-thread", {
      agentId: "agent-b",
    });
    const a = await readThreadMeta$("user-a", "org-a", "shared-thread");
    const b = await readThreadMeta$("user-b", "org-b", "shared-thread");
    expect(a?.agentId).toBe("agent-a");
    expect(b?.agentId).toBe("agent-b");
  });

  it("returns null for a corrupt row instead of throwing", async () => {
    // Seed the store via a normal write so the DB exists.
    await patchThreadMeta$(USER + "-corrupt", ORG, "thread-corrupt", {
      agentId: "agent-corrupt",
    });
    // Inject a malformed row directly. Reusing `openDB` here is intentional:
    // we want to bypass the schema-aware writer.
    const { openDB } = await import("idb");
    const db = await openDB(`vm0-chat-${USER}-corrupt-${ORG}`, 2);
    await db.put("chat_thread_agents", {
      threadId: "thread-bad",
      // missing updatedAt
    });
    db.close();

    const got = await readThreadMeta$(USER + "-corrupt", ORG, "thread-bad");
    expect(got).toBeNull();
  });

  it("coexists with the chat_messages store under the same DB", async () => {
    const stores = createIdbMessageStores(USER + "-coexist", ORG);
    await stores.writeStore.upsertMessages("thread-coexist", [
      {
        id: "m1",
        role: "user",
        content: "hi",
        createdAt: "2026-05-01T00:00:00Z",
      },
    ]);
    await patchThreadMeta$(USER + "-coexist", ORG, "thread-coexist", {
      agentId: "agent-coexist",
    });

    const messages = await stores.readStore.readLatest("thread-coexist", 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("m1");

    const meta = await readThreadMeta$(
      USER + "-coexist",
      ORG,
      "thread-coexist",
    );
    expect(meta?.agentId).toBe("agent-coexist");
  });
});
