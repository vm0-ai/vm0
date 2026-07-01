import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detach, Reason } from "../../utils.ts";

const idbStoreMock = vi.hoisted(() => {
  let cachedMessages: unknown[] = [];

  const readLatest = vi.fn((_threadId: string, limit?: number) => {
    if (limit === undefined) {
      return Promise.resolve(cachedMessages);
    }
    return Promise.resolve(cachedMessages.slice(-limit));
  });
  const messageExists = vi.fn((_threadId: string, messageId: string) => {
    return Promise.resolve(
      cachedMessages.some((message) => {
        return (
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          message.id === messageId
        );
      }),
    );
  });
  const upsertMessages = vi.fn((_threadId: string, messages: unknown[]) => {
    for (const message of messages) {
      if (
        typeof message !== "object" ||
        message === null ||
        !("id" in message)
      ) {
        continue;
      }
      const index = cachedMessages.findIndex((cached) => {
        return (
          typeof cached === "object" &&
          cached !== null &&
          "id" in cached &&
          cached.id === message.id
        );
      });
      if (index === -1) {
        cachedMessages.push(message);
      } else {
        cachedMessages[index] = message;
      }
    }
    return Promise.resolve();
  });

  const createIdbMessageStores = vi.fn((_userId: string, _orgId: string) => {
    return {
      readStore: {
        readLatest,
        messageExists,
        readBefore: () => {
          return Promise.resolve([]);
        },
      },
      writeStore: {
        upsertMessages,
      },
    };
  });

  return {
    createIdbMessageStores,
    readLatest,
    messageExists,
    upsertMessages,
    getMessages() {
      return cachedMessages;
    },
    setMessages(messages: unknown[]) {
      cachedMessages = messages;
    },
    reset() {
      cachedMessages = [];
      readLatest.mockClear();
      messageExists.mockClear();
      upsertMessages.mockClear();
      createIdbMessageStores.mockClear();
    },
  };
});

vi.mock("../../external/idb-message-store.ts", () => {
  return {
    createIdbMessageStores: idbStoreMock.createIdbMessageStores,
  };
});

function message(index: number): PagedChatMessage {
  const id = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
  return {
    id,
    role: index % 2 === 0 ? "assistant" : "user",
    content: `message ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  };
}

function range(start: number, end: number): PagedChatMessage[] {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    return message(start + offset);
  });
}

function ids(messages: PagedChatMessage[]): string[] {
  return messages.map((msg) => {
    return msg.id;
  });
}

describe("createIdbCachedDataSource initial page cache", () => {
  const ctx = testContext();

  afterEach(() => {
    idbStoreMock.reset();
    clearMockedAuth();
  });

  it("loads every cached IndexedDB message when entering a thread", async () => {
    mockUser({ id: "user_1", fullName: "Test User" }, { token: "token" });
    mockOrganization({
      activeOrg: { id: "org_1", name: "Test Org" },
      memberships: [{ id: "org_1" }],
    });

    const cachedMessages = range(1, 75);
    idbStoreMock.setMessages(cachedMessages);

    const { createIdbCachedDataSource } =
      await import("../idb-cached-chat-thread-data-source.ts");
    const dataSource = createIdbCachedDataSource("thread-1");

    const initialPage = await ctx.store.get(dataSource.initialPage$);

    expect(idbStoreMock.readLatest.mock.calls[0]?.length).toBe(1);
    expect(ids(initialPage.messages)).toStrictEqual(ids(cachedMessages));
  });

  it("warms latest messages from the cached cursor until the remote reaches the end", async () => {
    mockUser({ id: "user_1", fullName: "Test User" }, { token: "token" });
    mockOrganization({
      activeOrg: { id: "org_1", name: "Test Org" },
      memberships: [{ id: "org_1" }],
    });

    const threadId = "00000000-0000-4000-8000-000000000999";
    idbStoreMock.setMessages([message(1)]);
    const seenSinceIds: (string | undefined)[] = [];
    ctx.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
      seenSinceIds.push(query.sinceId);
      if (query.sinceId === message(1).id) {
        return respond(200, { messages: range(2, 51) });
      }
      return respond(200, { messages: range(52, 53) });
    });

    const { warmLatestChatThreadMessages$ } =
      await import("../idb-cached-chat-thread-data-source.ts");

    await ctx.store.set(warmLatestChatThreadMessages$, threadId, ctx.signal);

    expect(seenSinceIds).toStrictEqual([message(1).id, message(51).id]);
    expect(idbStoreMock.upsertMessages).toHaveBeenCalledTimes(2);
    expect(ids(idbStoreMock.getMessages() as PagedChatMessage[])).toStrictEqual(
      ids(range(1, 53)),
    );
  });

  it("reuses one IndexedDB message store wrapper across repeated background warms", async () => {
    mockUser(
      { id: "user_store_reuse", fullName: "Test User" },
      { token: "token" },
    );
    mockOrganization({
      activeOrg: { id: "org_store_reuse", name: "Test Org" },
      memberships: [{ id: "org_store_reuse" }],
    });

    idbStoreMock.setMessages([message(1)]);
    ctx.mocks.api(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: [] });
    });

    const { warmLatestChatThreadMessages$ } =
      await import("../idb-cached-chat-thread-data-source.ts");

    await ctx.store.set(
      warmLatestChatThreadMessages$,
      "00000000-0000-4000-8000-000000000997",
      ctx.signal,
    );
    await ctx.store.set(
      warmLatestChatThreadMessages$,
      "00000000-0000-4000-8000-000000000996",
      ctx.signal,
    );

    expect(idbStoreMock.createIdbMessageStores).toHaveBeenCalledTimes(1);
    expect(idbStoreMock.createIdbMessageStores).toHaveBeenCalledWith(
      "user_store_reuse",
      "org_store_reuse",
    );
  });

  it("keeps warming later run-finished payloads after a stale thread payload", async () => {
    mockUser({ id: "user_1", fullName: "Test User" }, { token: "token" });
    mockOrganization({
      activeOrg: { id: "org_1", name: "Test Org" },
      memberships: [{ id: "org_1" }],
    });

    const staleThreadId = "00000000-0000-4000-8000-000000000998";
    const liveThreadId = "00000000-0000-4000-8000-000000000999";
    idbStoreMock.setMessages([message(1)]);
    const seenThreadIds: string[] = [];
    ctx.mocks.api(chatThreadMessagesContract.list, ({ params, respond }) => {
      seenThreadIds.push(params.threadId);
      if (params.threadId === staleThreadId) {
        return respond(404, {
          error: { message: "Thread not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, { messages: [message(2)] });
    });

    const { setupRealtime$ } = await import("../../realtime.ts");
    const { subscribeBackgroundChatThreadRunFinished$ } =
      await import("../background-chat-thread-cache.ts");

    await ctx.store.set(setupRealtime$, ctx.signal);
    const subscriptionPromise = ctx.store.set(
      subscribeBackgroundChatThreadRunFinished$,
      ctx.signal,
    );
    detach(subscriptionPromise, Reason.Daemon);
    await waitFor(() => {
      expect(
        ctx.mocks.ably.hasSubscription("chatThreadRunFinished"),
      ).toBeTruthy();
    });

    ctx.mocks.ably.trigger("chatThreadRunFinished", {
      threadId: staleThreadId,
    });
    await waitFor(() => {
      expect(seenThreadIds).toContain(staleThreadId);
    });

    ctx.mocks.ably.trigger("chatThreadRunFinished", { threadId: liveThreadId });
    await waitFor(() => {
      expect(seenThreadIds).toContain(liveThreadId);
      expect(idbStoreMock.upsertMessages).toHaveBeenCalledWith(
        liveThreadId,
        [message(2)],
        ctx.signal,
      );
    });
  });
});
