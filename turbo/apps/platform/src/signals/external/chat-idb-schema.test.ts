import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_MESSAGES_ORDER_INDEX,
  CHAT_MESSAGES_STORE,
  CHAT_THREAD_META_STORE,
  upgradeChatIdb,
} from "./chat-idb-schema.ts";

interface FakeObjectStore {
  readonly createIndex: ReturnType<typeof vi.fn>;
}

function fakeDb(existingStores: readonly string[]) {
  const stores = new Set(existingStores);
  const objectStores = new Map<string, FakeObjectStore>();
  const createdStores = new Map<string, FakeObjectStore>();
  const deleteObjectStore = vi.fn((name: string) => {
    stores.delete(name);
    objectStores.delete(name);
  });
  const createObjectStore = vi.fn((name: string) => {
    stores.add(name);
    const store = {
      createIndex: vi.fn(),
    };
    objectStores.set(name, store);
    createdStores.set(name, store);
    return store;
  });
  for (const name of existingStores) {
    objectStores.set(name, { createIndex: vi.fn() });
  }
  const objectStore = vi.fn((name: string) => {
    const store = objectStores.get(name);
    if (!store) {
      throw new Error(`unknown fake object store: ${name}`);
    }
    return store;
  });
  const tx = {
    objectStore,
  } as unknown as Parameters<typeof upgradeChatIdb>[2];

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
    tx,
    objectStores,
    createdStores,
    createObjectStore,
    deleteObjectStore,
  };
}

describe("upgradeChatIdb", () => {
  it("clears legacy chat cache when upgrading to v4", () => {
    const { db, tx, createdStores, createObjectStore, deleteObjectStore } =
      fakeDb([CHAT_MESSAGES_STORE, CHAT_THREAD_META_STORE]);

    upgradeChatIdb(db, 3, tx);

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
    expect(
      createdStores.get(CHAT_MESSAGES_STORE)?.createIndex,
    ).toHaveBeenCalledWith(CHAT_MESSAGES_ORDER_INDEX, [
      "threadId",
      "createdAt",
      "orderSequence",
      "id",
    ]);
  });

  it("adds the stable order index when upgrading existing v4 chat cache", () => {
    const { db, tx, objectStores, createObjectStore, deleteObjectStore } =
      fakeDb([CHAT_MESSAGES_STORE, CHAT_THREAD_META_STORE]);

    upgradeChatIdb(db, 4, tx);

    expect(deleteObjectStore).not.toHaveBeenCalled();
    expect(createObjectStore).not.toHaveBeenCalled();
    expect(
      objectStores.get(CHAT_MESSAGES_STORE)?.createIndex,
    ).toHaveBeenCalledWith(CHAT_MESSAGES_ORDER_INDEX, [
      "threadId",
      "createdAt",
      "orderSequence",
      "id",
    ]);
  });
});
