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
  let indexedDbMessages: unknown[] = [];

  const readLatest = vi.fn((_threadId: string, limit?: number) => {
    if (limit === undefined) {
      return Promise.resolve(indexedDbMessages);
    }
    return Promise.resolve(indexedDbMessages.slice(-limit));
  });
  const readBefore = vi.fn(
    (_threadId: string, beforeId: string, limit: number) => {
      const beforeIndex = indexedDbMessages.findIndex((message) => {
        return (
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          message.id === beforeId
        );
      });
      if (beforeIndex === -1) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        indexedDbMessages.slice(Math.max(0, beforeIndex - limit), beforeIndex),
      );
    },
  );
  const messageExists = vi.fn((_threadId: string, messageId: string) => {
    return Promise.resolve(
      indexedDbMessages.some((message) => {
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
      const index = indexedDbMessages.findIndex((persisted) => {
        return (
          typeof persisted === "object" &&
          persisted !== null &&
          "id" in persisted &&
          persisted.id === message.id
        );
      });
      if (index === -1) {
        indexedDbMessages.push(message);
      } else {
        indexedDbMessages[index] = message;
      }
    }
    return Promise.resolve();
  });

  return {
    readLatest,
    readBefore,
    messageExists,
    upsertMessages,
    getMessages() {
      return indexedDbMessages;
    },
    setMessages(messages: unknown[]) {
      indexedDbMessages = messages;
    },
    reset() {
      indexedDbMessages = [];
      readLatest.mockClear();
      readBefore.mockClear();
      messageExists.mockClear();
      upsertMessages.mockClear();
    },
  };
});

vi.mock("../../external/idb-message-store.ts", () => {
  return {
    createIdbMessageStores: () => {
      return {
        readStore: {
          readLatest: idbStoreMock.readLatest,
          messageExists: idbStoreMock.messageExists,
          readBefore: idbStoreMock.readBefore,
        },
        writeStore: {
          upsertMessages: idbStoreMock.upsertMessages,
        },
      };
    },
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

describe("chat message IndexedDB persistence", () => {
  const ctx = testContext();

  afterEach(() => {
    idbStoreMock.reset();
    clearMockedAuth();
  });

  it("loads every IndexedDB message when entering a thread", async () => {
    mockUser({ id: "user_1", fullName: "Test User" }, { token: "token" });
    mockOrganization({
      activeOrg: { id: "org_1", name: "Test Org" },
      memberships: [{ id: "org_1" }],
    });

    const indexedDbMessages = range(1, 75);
    idbStoreMock.setMessages(indexedDbMessages);

    const { loadIndexedDbChatMessages$ } =
      await import("../chat-message-indexed-db.ts");

    const messages = await ctx.store.set(
      loadIndexedDbChatMessages$,
      "thread-1",
      ctx.signal,
    );

    expect(idbStoreMock.readLatest).toHaveBeenCalledWith(
      "thread-1",
      undefined,
      ctx.signal,
    );
    expect(ids(messages)).toStrictEqual(ids(indexedDbMessages));
  });

  it("writes API messages to IndexedDB for thread re-entry", async () => {
    mockUser({ id: "user_2", fullName: "Test User" }, { token: "token" });
    mockOrganization({
      activeOrg: { id: "org_2", name: "Test Org" },
      memberships: [{ id: "org_2" }],
    });

    const threadId = "00000000-0000-4000-8000-000000000997";
    const { loadIndexedDbChatMessages$, writeIndexedDbChatMessages$ } =
      await import("../chat-message-indexed-db.ts");
    await ctx.store.set(
      writeIndexedDbChatMessages$,
      threadId,
      range(1, 2),
      ctx.signal,
    );
    const indexedDbMessages = await ctx.store.set(
      loadIndexedDbChatMessages$,
      threadId,
      ctx.signal,
    );

    expect(idbStoreMock.upsertMessages).toHaveBeenCalledWith(
      threadId,
      range(1, 2),
      ctx.signal,
    );
    expect(ids(indexedDbMessages)).toStrictEqual(ids(range(1, 2)));
  });

  it("loads all IndexedDB messages before the current window", async () => {
    mockUser({ id: "user_3", fullName: "Test User" }, { token: "token" });
    mockOrganization({
      activeOrg: { id: "org_3", name: "Test Org" },
      memberships: [{ id: "org_3" }],
    });

    const indexedDbMessages = range(1, 121);
    idbStoreMock.setMessages(indexedDbMessages);
    const { loadIndexedDbChatMessagesBefore$ } =
      await import("../chat-message-indexed-db.ts");

    const messages = await ctx.store.set(
      loadIndexedDbChatMessagesBefore$,
      "thread-1",
      message(121).id,
      ctx.signal,
    );

    expect(ids(messages)).toStrictEqual(ids(range(1, 120)));
    expect(idbStoreMock.readBefore).toHaveBeenCalledTimes(3);
  });

  it("warms latest messages from the IndexedDB cursor until the remote reaches the end", async () => {
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
      await import("../chat-message-indexed-db.ts");

    await ctx.store.set(warmLatestChatThreadMessages$, threadId, ctx.signal);

    expect(seenSinceIds).toStrictEqual([message(1).id, message(51).id]);
    expect(idbStoreMock.upsertMessages).toHaveBeenCalledTimes(2);
    expect(ids(idbStoreMock.getMessages() as PagedChatMessage[])).toStrictEqual(
      ids(range(1, 53)),
    );
  });

  it("keeps warming later followups-finished payloads after a stale thread payload", async () => {
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
    const { subscribeBackgroundChatThreadFollowupsFinished$ } =
      await import("../background-chat-thread-cache.ts");

    await ctx.store.set(setupRealtime$, ctx.signal);
    const subscriptionPromise = ctx.store.set(
      subscribeBackgroundChatThreadFollowupsFinished$,
      ctx.signal,
    );
    detach(subscriptionPromise, Reason.Daemon);
    await waitFor(() => {
      expect(
        ctx.mocks.ably.hasSubscription("chatThreadFollowupsFinished"),
      ).toBeTruthy();
    });

    ctx.mocks.ably.trigger("chatThreadFollowupsFinished", {
      threadId: staleThreadId,
    });
    await waitFor(() => {
      expect(seenThreadIds).toContain(staleThreadId);
    });

    ctx.mocks.ably.trigger("chatThreadFollowupsFinished", {
      threadId: "not-a-valid-thread-id",
    });
    ctx.mocks.ably.trigger("chatThreadFollowupsFinished", {
      threadId: liveThreadId,
    });
    await waitFor(() => {
      expect(seenThreadIds).toContain(liveThreadId);
      expect(seenThreadIds).not.toContain("not-a-valid-thread-id");
      expect(idbStoreMock.upsertMessages).toHaveBeenCalledWith(
        liveThreadId,
        [message(2)],
        ctx.signal,
      );
    });
  });
});
