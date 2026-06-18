import { afterEach, describe, expect, it, vi } from "vitest";
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

  return {
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
          readBefore: () => {
            return Promise.resolve([]);
          },
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
});
