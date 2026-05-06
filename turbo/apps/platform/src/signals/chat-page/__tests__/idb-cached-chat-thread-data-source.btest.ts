import { describe, expect, it } from "vitest";
import {
  mockUser,
  mockOrganization,
  clearMockedAuth,
} from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createIdbCachedDataSource } from "../idb-cached-chat-thread-data-source.ts";
import { createIdbMessageStores } from "../../external/idb-message-store.ts";
import { patchThreadMeta$ } from "../../external/idb-thread-meta-store.ts";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";

function makeMsg(id: string, createdAt: string): PagedChatMessage {
  return {
    id,
    role: "user" as const,
    content: `msg ${id}`,
    createdAt,
  };
}

const USER_ID = "btest-cache-user";
const ORG_ID = "btest-cache-org";

function setupAuth() {
  clearMockedAuth();
  mockUser({ id: USER_ID, fullName: "Test User" }, { token: "test-token" });
  mockOrganization({
    activeOrg: { id: ORG_ID, name: "Test Org" },
  });
}

const context = testContext();

describe("createIdbCachedDataSource initialPage cache-hit + thread meta", () => {
  it("cache hit returns hasHistoryBefore=true when startMessageId is unknown", async () => {
    setupAuth();
    const threadId = `thread-initial-unknown-${Date.now()}`;
    const stores = createIdbMessageStores(USER_ID, ORG_ID);
    await stores.writeStore.upsertMessages(threadId, [
      makeMsg("a", "2026-08-01T00:00:00Z"),
      makeMsg("b", "2026-08-02T00:00:00Z"),
    ]);

    const ds = createIdbCachedDataSource(threadId);
    const page = await context.store.get(ds.initialPage$);
    expect(page.hasHistoryBefore).toBeTruthy();
    expect(
      page.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual(["a", "b"]);
  });

  it("cache hit returns hasHistoryBefore=false once startMessageId is persisted", async () => {
    setupAuth();
    const threadId = `thread-initial-known-${Date.now()}`;
    const stores = createIdbMessageStores(USER_ID, ORG_ID);
    await stores.writeStore.upsertMessages(threadId, [
      makeMsg("first", "2026-08-01T00:00:00Z"),
      makeMsg("second", "2026-08-02T00:00:00Z"),
    ]);
    await patchThreadMeta$(USER_ID, ORG_ID, threadId, {
      startMessageId: "first",
    });

    const ds = createIdbCachedDataSource(threadId);
    const page = await context.store.get(ds.initialPage$);
    expect(page.hasHistoryBefore).toBeFalsy();
    expect(
      page.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual(["first", "second"]);
  });
});

describe("createIdbCachedDataSource listMessagesBefore cache-hit + thread meta", () => {
  it("cache hit returns hasMore=true when startMessageId is unknown", async () => {
    setupAuth();
    const threadId = `thread-before-unknown-${Date.now()}`;
    const stores = createIdbMessageStores(USER_ID, ORG_ID);
    await stores.writeStore.upsertMessages(threadId, [
      makeMsg("older", "2026-09-01T00:00:00Z"),
      makeMsg("anchor", "2026-09-02T00:00:00Z"),
    ]);

    const ds = createIdbCachedDataSource(threadId);
    const result = await context.store.set(
      ds.listMessagesBefore$,
      { threadId, beforeId: "anchor" },
      context.signal,
    );
    expect(result.hasMore).toBeTruthy();
    expect(
      result.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual(["older"]);
  });

  it("cache hit returns hasMore=false once startMessageId matches a cached message", async () => {
    setupAuth();
    const threadId = `thread-before-known-${Date.now()}`;
    const stores = createIdbMessageStores(USER_ID, ORG_ID);
    await stores.writeStore.upsertMessages(threadId, [
      makeMsg("first", "2026-09-01T00:00:00Z"),
      makeMsg("anchor", "2026-09-02T00:00:00Z"),
    ]);
    await patchThreadMeta$(USER_ID, ORG_ID, threadId, {
      startMessageId: "first",
    });

    const ds = createIdbCachedDataSource(threadId);
    const result = await context.store.set(
      ds.listMessagesBefore$,
      { threadId, beforeId: "anchor" },
      context.signal,
    );
    expect(result.hasMore).toBeFalsy();
    expect(
      result.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual(["first"]);
  });
});
