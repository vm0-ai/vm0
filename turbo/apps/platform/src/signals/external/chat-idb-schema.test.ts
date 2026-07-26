import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_IDB_VERSION,
  CHAT_MESSAGES_ORDER_INDEX,
  CHAT_MESSAGES_STORE,
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
  upgradeChatIdb,
} from "./chat-idb-schema.ts";

// The artifacts page no longer mirrors artifact history, so these stores exist
// only in databases created by an older bundle and are dropped on upgrade.
const LEGACY_ARTIFACT_ITEMS_STORE = "artifact_items";
const LEGACY_ARTIFACT_SYNC_STORE = "artifact_sync";

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

function legacyStores(): string[] {
  return [
    CHAT_MESSAGES_STORE,
    CHAT_THREAD_SNAPSHOT_STORE,
    CHAT_THREAD_EVENTS_STORE,
    CHAT_THREAD_EVENT_SYNC_STORE,
    LEGACY_ARTIFACT_ITEMS_STORE,
    LEGACY_ARTIFACT_SYNC_STORE,
  ];
}

function expectChatMessagesStoreCreated(
  createdStores: ReturnType<typeof fakeDb>["createdStores"],
  createObjectStore: ReturnType<typeof fakeDb>["createObjectStore"],
): void {
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE, {
    keyPath: "id",
  });
  expect(
    createdStores.get(CHAT_MESSAGES_STORE)?.createIndex,
  ).toHaveBeenCalledWith(CHAT_MESSAGES_ORDER_INDEX, ["threadId", "seqId"], {
    unique: true,
  });
}

function expectThreadEventStoresCreated(
  createdStores: ReturnType<typeof fakeDb>["createdStores"],
  createObjectStore: ReturnType<typeof fakeDb>["createObjectStore"],
): void {
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_THREAD_SNAPSHOT_STORE, {
    keyPath: "id",
  });
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_THREAD_EVENTS_STORE, {
    keyPath: "id",
  });
  expect(createObjectStore).toHaveBeenCalledWith(CHAT_THREAD_EVENT_SYNC_STORE, {
    keyPath: "id",
  });
  expect(
    createdStores.get(CHAT_THREAD_EVENTS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(CHAT_THREAD_EVENTS_ORDER_INDEX, ["createdAt", "id"]);
}

function expectAllLocalCacheStoresDeleted(
  deleteObjectStore: ReturnType<typeof fakeDb>["deleteObjectStore"],
): void {
  expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
  expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_THREAD_SNAPSHOT_STORE);
  expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_THREAD_EVENTS_STORE);
  expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_THREAD_EVENT_SYNC_STORE);
  expect(deleteObjectStore).toHaveBeenCalledWith(LEGACY_ARTIFACT_ITEMS_STORE);
  expect(deleteObjectStore).toHaveBeenCalledWith(LEGACY_ARTIFACT_SYNC_STORE);
}

describe("upgradeChatIdb local cache resets", () => {
  it.each([13, 14, 15, 17])(
    "resets every local cache and leaves no artifact store when upgrading from v%i",
    (oldVersion) => {
      const { db, createdStores, createObjectStore, deleteObjectStore } =
        fakeDb(legacyStores());

      upgradeChatIdb(db, oldVersion);

      expect(deleteObjectStore).toHaveBeenCalledTimes(6);
      expectAllLocalCacheStoresDeleted(deleteObjectStore);
      expect(createObjectStore).toHaveBeenCalledTimes(4);
      expectChatMessagesStoreCreated(createdStores, createObjectStore);
      expectThreadEventStoresCreated(createdStores, createObjectStore);
      expect(createObjectStore).not.toHaveBeenCalledWith(
        LEGACY_ARTIFACT_ITEMS_STORE,
        expect.anything(),
      );
      expect(createObjectStore).not.toHaveBeenCalledWith(
        LEGACY_ARTIFACT_SYNC_STORE,
        expect.anything(),
      );
    },
  );

  it.each([18, 19])(
    "drops artifact history and rebuilds chat events when upgrading from v%i",
    (oldVersion) => {
      const { db, createdStores, createObjectStore, deleteObjectStore } =
        fakeDb(legacyStores());

      upgradeChatIdb(db, oldVersion);

      expect(deleteObjectStore).toHaveBeenCalledTimes(3);
      expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
      expect(deleteObjectStore).toHaveBeenCalledWith(
        LEGACY_ARTIFACT_ITEMS_STORE,
      );
      expect(deleteObjectStore).toHaveBeenCalledWith(
        LEGACY_ARTIFACT_SYNC_STORE,
      );
      expect(createObjectStore).toHaveBeenCalledTimes(1);
      expectChatMessagesStoreCreated(createdStores, createObjectStore);
    },
  );

  it("resets only the legacy chat cache when upgrading from v20", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 20);

    expect(deleteObjectStore).toHaveBeenCalledTimes(1);
    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
    expect(createObjectStore).toHaveBeenCalledTimes(1);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
  });

  it("does not rebuild local caches at the current schema version", () => {
    const { db, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, CHAT_IDB_VERSION);

    expect(deleteObjectStore).not.toHaveBeenCalled();
    expect(createObjectStore).not.toHaveBeenCalled();
  });
});
