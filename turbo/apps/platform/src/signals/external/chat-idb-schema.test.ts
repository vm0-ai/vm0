import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_MESSAGES_STORE,
  CHAT_THREAD_META_STORE,
  upgradeChatIdb,
} from "./chat-idb-schema.ts";

function fakeDb(existingStores: readonly string[]) {
  const stores = new Set(existingStores);
  const createdStores = new Map<
    string,
    {
      createIndex: ReturnType<typeof vi.fn>;
    }
  >();
  const deleteObjectStore = vi.fn((name: string) => {
    stores.delete(name);
  });
  const createObjectStore = vi.fn((name: string) => {
    stores.add(name);
    const store = {
      createIndex: vi.fn(),
    };
    createdStores.set(name, store);
    return store;
  });

  return {
    db: {
      objectStoreNames: {
        contains: (name: string) => {
          return stores.has(name);
        },
      },
      deleteObjectStore,
      createObjectStore,
    } as unknown as IDBPDatabase,
    createdStores,
    createObjectStore,
    deleteObjectStore,
  };
}

describe("upgradeChatIdb", () => {
  it("clears legacy chat cache when upgrading to v4", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_META_STORE,
    ]);

    upgradeChatIdb(db, 3);

    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_THREAD_META_STORE);
    expect(createObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE, {
      keyPath: "id",
    });
    expect(createObjectStore).toHaveBeenCalledWith(CHAT_THREAD_META_STORE, {
      keyPath: "threadId",
    });
    expect(
      createdStores.get(CHAT_MESSAGES_STORE)?.createIndex,
    ).toHaveBeenCalledWith("byThreadAndTime", ["threadId", "createdAt"]);
  });
});
