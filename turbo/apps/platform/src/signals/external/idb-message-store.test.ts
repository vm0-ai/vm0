import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";

const require = createRequire(import.meta.url);

function message(args: {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly createdAt: string;
  readonly sequenceNumber?: number | null;
}): PagedChatMessage {
  return {
    id: args.id,
    role: args.role,
    content: args.id,
    createdAt: args.createdAt,
    sequenceNumber: args.sequenceNumber,
  };
}

function ids(messages: readonly PagedChatMessage[]): string[] {
  return messages.map((msg) => {
    return msg.id;
  });
}

async function createRealIdbMessageStores() {
  vi.resetModules();
  // The app test config aliases idb to a cache-miss mock; this store test needs
  // the real idb wrapper running on fake-indexeddb from the shared test setup.
  vi.doMock("idb", () => {
    return require("idb") as typeof import("idb");
  });
  const { createIdbMessageStores } = await import("./idb-message-store.ts");
  return createIdbMessageStores(`user-${randomUUID()}`, `org-${randomUUID()}`);
}

describe("createIdbMessageStores", () => {
  afterEach(() => {
    vi.doUnmock("idb");
    vi.resetModules();
  });

  it("reads cached messages in server cursor order", async () => {
    const stores = await createRealIdbMessageStores();
    const threadId = "thread-1";
    const otherThreadId = "thread-2";
    const firstTime = "2026-06-01T00:00:00.000Z";
    const secondTime = "2026-06-01T00:00:01.000Z";
    const m1 = message({
      id: "00000000-0000-4000-8000-000000000001",
      role: "assistant",
      createdAt: firstTime,
      sequenceNumber: null,
    });
    const m2 = message({
      id: "00000000-0000-4000-8000-000000000002",
      role: "user",
      createdAt: firstTime,
      sequenceNumber: 2,
    });
    const m3 = message({
      id: "00000000-0000-4000-8000-000000000003",
      role: "assistant",
      createdAt: firstTime,
      sequenceNumber: null,
    });
    const m4 = message({
      id: "00000000-0000-4000-8000-000000000004",
      role: "user",
      createdAt: secondTime,
      sequenceNumber: 0,
    });
    const otherThreadMessage = message({
      id: "00000000-0000-4000-8000-000000000999",
      role: "assistant",
      createdAt: secondTime,
      sequenceNumber: 0,
    });

    await stores.writeStore.upsertMessages(threadId, [m4, m3, m2, m1]);
    await stores.writeStore.upsertMessages(otherThreadId, [otherThreadMessage]);

    await expect(stores.readStore.messageExists(threadId, m1.id)).resolves.toBe(
      true,
    );
    await expect(
      stores.readStore.messageExists(threadId, otherThreadMessage.id),
    ).resolves.toBe(false);

    const latest = await stores.readStore.readLatest(threadId);
    expect(ids(latest)).toStrictEqual(ids([m1, m3, m2, m4]));
    expect(latest).not.toContainEqual(otherThreadMessage);

    await expect(
      stores.readStore.readLatest(threadId, 2),
    ).resolves.toStrictEqual([m2, m4]);
    await expect(
      stores.readStore.readBefore(threadId, m4.id, 2),
    ).resolves.toStrictEqual([m3, m2]);
    await expect(
      stores.readStore.readBefore(threadId, m2.id, 10),
    ).resolves.toStrictEqual([m1, m3]);
    await expect(
      stores.readStore.readBefore(threadId, otherThreadMessage.id, 10),
    ).resolves.toStrictEqual([]);
  });
});
