import { afterEach, describe, expect, it, vi } from "vitest";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
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

  return {
    readLatest,
    setMessages(messages: unknown[]) {
      cachedMessages = messages;
    },
    reset() {
      cachedMessages = [];
      readLatest.mockClear();
    },
  };
});

vi.mock("../../external/idb-message-store.ts", () => {
  return {
    createIdbMessageStores: () => {
      return {
        readStore: {
          readLatest: idbStoreMock.readLatest,
          messageExists: () => {
            return Promise.resolve(false);
          },
          readBefore: () => {
            return Promise.resolve([]);
          },
        },
        writeStore: {
          upsertMessages: () => {
            return Promise.resolve();
          },
        },
      };
    },
  };
});

function message(index: number): PagedChatMessage {
  const id = `m${index.toString().padStart(3, "0")}`;
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
});
