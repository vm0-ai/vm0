import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";

import {
  CHAT_EVENT_CURSOR_STORE,
  CHAT_EVENT_ROWS_ORDER_INDEX,
  CHAT_EVENT_ROWS_STORE,
  CHAT_IDB_CACHE_SCHEMA_VERSION_BASE,
  CHAT_IDB_VERSION,
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
  upgradeChatIdb,
} from "./chat-idb-schema.ts";

interface FakeObjectStore {
  readonly createIndex: ReturnType<typeof vi.fn>;
}

function fakeDb(existingStores: readonly string[]) {
  const stores = new Set(existingStores);
  const createdStores = new Map<string, FakeObjectStore>();
  const deleteObjectStore = vi.fn((name: string) => {
    stores.delete(name);
  });
  const createObjectStore = vi.fn((name: string) => {
    stores.add(name);
    const store = { createIndex: vi.fn() };
    createdStores.set(name, store);
    return store;
  });
  return {
    db: {
      objectStoreNames: {
        contains: (name: string) => {
          return stores.has(name);
        },
        [Symbol.iterator]: () => {
          return stores.values();
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

function currentStores(): string[] {
  return [
    CHAT_EVENT_ROWS_STORE,
    CHAT_EVENT_CURSOR_STORE,
    CHAT_THREAD_SNAPSHOT_STORE,
    CHAT_THREAD_EVENTS_STORE,
    CHAT_THREAD_EVENT_SYNC_STORE,
  ];
}

function expectCurrentStoresCreated(
  createdStores: ReturnType<typeof fakeDb>["createdStores"],
  createObjectStore: ReturnType<typeof fakeDb>["createObjectStore"],
): void {
  expect(createObjectStore).toHaveBeenCalledTimes(5);
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_EVENT_ROWS_STORE, {
    keyPath: "id",
  });
  expect(
    createdStores.get(CHAT_EVENT_ROWS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(
    CHAT_EVENT_ROWS_ORDER_INDEX,
    ["chatThreadId", "seqId"],
    { unique: true },
  );
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_EVENT_CURSOR_STORE, {
    keyPath: "threadId",
  });
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_THREAD_SNAPSHOT_STORE, {
    keyPath: "id",
  });
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_THREAD_EVENTS_STORE, {
    keyPath: "id",
  });
  expect(
    createdStores.get(CHAT_THREAD_EVENTS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(CHAT_THREAD_EVENTS_ORDER_INDEX, "seqId", {
    unique: true,
  });
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_THREAD_EVENT_SYNC_STORE, {
    keyPath: "id",
  });
}

describe("upgradeChatIdb", () => {
  it("derives the database version from cache and Chat Event versions", () => {
    expect(CHAT_IDB_VERSION).toBe(
      CHAT_IDB_CACHE_SCHEMA_VERSION_BASE + CURRENT_CHAT_EVENT_SCHEMA_VERSION,
    );
  });

  it("creates the current cache stores for a new database", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb(
      [],
    );

    upgradeChatIdb(db, 0);

    expect(deleteObjectStore).not.toHaveBeenCalled();
    expectCurrentStoresCreated(createdStores, createObjectStore);
  });

  it("deletes and recreates every cache store on an upgrade", () => {
    const previousStores = [...currentStores(), "retired_cache"];
    const { db, createdStores, createObjectStore, deleteObjectStore } =
      fakeDb(previousStores);

    upgradeChatIdb(db, CHAT_IDB_VERSION - 1);

    for (const storeName of previousStores) {
      expect(deleteObjectStore).toHaveBeenCalledWith(storeName);
    }
    expectCurrentStoresCreated(createdStores, createObjectStore);
  });

  it("does not mutate a database already at the current version", () => {
    const { db, createObjectStore, deleteObjectStore } =
      fakeDb(currentStores());

    upgradeChatIdb(db, CHAT_IDB_VERSION);

    expect(deleteObjectStore).not.toHaveBeenCalled();
    expect(createObjectStore).not.toHaveBeenCalled();
  });
});
