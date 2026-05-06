import { describe, expect, it } from "vitest";
import {
  readThreadAgentId$,
  writeThreadAgentId$,
} from "../idb-thread-agent-store";
import { createIdbMessageStores } from "../idb-message-store";

const USER = "test-user";
const ORG = "test-org";

describe("idb-thread-agent-store", () => {
  it("write then read returns the cached agentId", async () => {
    await writeThreadAgentId$(USER + "-rw", ORG, "thread-rw", "agent-rw");
    const got = await readThreadAgentId$(USER + "-rw", ORG, "thread-rw");
    expect(got).toBe("agent-rw");
  });

  it("read on missing key returns null", async () => {
    const got = await readThreadAgentId$(USER + "-miss", ORG, "thread-missing");
    expect(got).toBeNull();
  });

  it("second write replaces the row (latest-wins)", async () => {
    await writeThreadAgentId$(
      USER + "-update",
      ORG,
      "thread-update",
      "agent-1",
    );
    await writeThreadAgentId$(
      USER + "-update",
      ORG,
      "thread-update",
      "agent-2",
    );
    const got = await readThreadAgentId$(
      USER + "-update",
      ORG,
      "thread-update",
    );
    expect(got).toBe("agent-2");
  });

  it("scopes rows by (userId, orgId)", async () => {
    await writeThreadAgentId$("user-a", "org-a", "shared-thread", "agent-a");
    await writeThreadAgentId$("user-b", "org-b", "shared-thread", "agent-b");
    const a = await readThreadAgentId$("user-a", "org-a", "shared-thread");
    const b = await readThreadAgentId$("user-b", "org-b", "shared-thread");
    expect(a).toBe("agent-a");
    expect(b).toBe("agent-b");
  });

  it("returns null for a corrupt row instead of throwing", async () => {
    // Seed the store via a normal write so the DB exists.
    await writeThreadAgentId$(
      USER + "-corrupt",
      ORG,
      "thread-corrupt",
      "agent-corrupt",
    );
    // Inject a malformed row directly. Reusing `openDB` here is intentional:
    // we want to bypass the schema-aware writer.
    const { openDB } = await import("idb");
    const db = await openDB(`vm0-chat-${USER}-corrupt-${ORG}`, 2);
    await db.put("chat_thread_agents", {
      threadId: "thread-bad",
      // missing agentId, updatedAt
    });
    db.close();

    const got = await readThreadAgentId$(USER + "-corrupt", ORG, "thread-bad");
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
    await writeThreadAgentId$(
      USER + "-coexist",
      ORG,
      "thread-coexist",
      "agent-coexist",
    );

    const messages = await stores.readStore.readLatest("thread-coexist", 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("m1");

    const agentId = await readThreadAgentId$(
      USER + "-coexist",
      ORG,
      "thread-coexist",
    );
    expect(agentId).toBe("agent-coexist");
  });
});
