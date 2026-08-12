import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";

import {
  CHAT_EVENT_ROWS_ORDER_INDEX,
  CHAT_EVENT_ROWS_STORE,
  CHAT_IDB_VERSION,
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
  upgradeChatIdb,
} from "./chat-idb-schema.ts";

const LEGACY_ARTIFACT_ITEMS_STORE = "artifact_items";
const LEGACY_ARTIFACT_SYNC_STORE = "artifact_sync";
const LEGACY_CHAT_MESSAGES_STORE = "chat_messages";
const LEGACY_CHAT_THREAD_META_STORE = "chat_thread_agents";

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
    CHAT_THREAD_SNAPSHOT_STORE,
    CHAT_THREAD_EVENTS_STORE,
    CHAT_THREAD_EVENT_SYNC_STORE,
  ];
}

function expectCurrentStoresCreated(
  createdStores: ReturnType<typeof fakeDb>["createdStores"],
  createObjectStore: ReturnType<typeof fakeDb>["createObjectStore"],
): void {
  expect(createObjectStore).toHaveBeenCalledTimes(4);
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
  it("creates only canonical event-row and thread-list stores for a new database", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb(
      [],
    );

    upgradeChatIdb(db, 0);

    expect(deleteObjectStore).not.toHaveBeenCalled();
    expectCurrentStoresCreated(createdStores, createObjectStore);
  });

  it("removes the projected chat-event cache when upgrading from v30", () => {
    const { db, createObjectStore, deleteObjectStore } = fakeDb([
      LEGACY_CHAT_MESSAGES_STORE,
      ...currentStores(),
    ]);

    upgradeChatIdb(db, 30);

    expect(deleteObjectStore).toHaveBeenCalledTimes(1);
    expect(deleteObjectStore).toHaveBeenCalledWith(LEGACY_CHAT_MESSAGES_STORE);
    expect(createObjectStore).not.toHaveBeenCalled();
  });

  it("rebuilds pre-canonical raw rows and drops the projected cache from v29", () => {
    const unrelatedStore = "unrelated_local_data";
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      LEGACY_CHAT_MESSAGES_STORE,
      ...currentStores(),
      unrelatedStore,
    ]);

    upgradeChatIdb(db, 29);

    expect(deleteObjectStore).toHaveBeenCalledTimes(2);
    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_EVENT_ROWS_STORE);
    expect(deleteObjectStore).toHaveBeenCalledWith(LEGACY_CHAT_MESSAGES_STORE);
    expect(deleteObjectStore).not.toHaveBeenCalledWith(unrelatedStore);
    expect(createObjectStore).toHaveBeenCalledTimes(1);
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
  });

  it("drops legacy caches during an old-schema upgrade without recreating them", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      LEGACY_CHAT_MESSAGES_STORE,
      LEGACY_CHAT_THREAD_META_STORE,
      LEGACY_ARTIFACT_ITEMS_STORE,
      LEGACY_ARTIFACT_SYNC_STORE,
      ...currentStores(),
    ]);

    upgradeChatIdb(db, 17);

    for (const legacyStore of [
      LEGACY_CHAT_MESSAGES_STORE,
      LEGACY_CHAT_THREAD_META_STORE,
      LEGACY_ARTIFACT_ITEMS_STORE,
      LEGACY_ARTIFACT_SYNC_STORE,
    ]) {
      expect(deleteObjectStore).toHaveBeenCalledWith(legacyStore);
      expect(createObjectStore).not.toHaveBeenCalledWith(
        legacyStore,
        expect.anything(),
      );
    }
    expectCurrentStoresCreated(createdStores, createObjectStore);
  });

  it("does not mutate a database already at the current schema version", () => {
    const { db, createObjectStore, deleteObjectStore } =
      fakeDb(currentStores());

    upgradeChatIdb(db, CHAT_IDB_VERSION);

    expect(deleteObjectStore).not.toHaveBeenCalled();
    expect(createObjectStore).not.toHaveBeenCalled();
  });
});
