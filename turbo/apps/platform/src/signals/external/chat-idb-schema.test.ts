import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_ITEMS_AGENT_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_AGENT_KIND_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_KIND_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_RUN_FILE_INDEX,
  ARTIFACT_ITEMS_STORE,
  ARTIFACT_SYNC_STORE,
  CHAT_MESSAGES_ORDER_INDEX,
  CHAT_MESSAGES_STORE,
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
  upgradeChatIdb,
} from "./chat-idb-schema.ts";

const LEGACY_CHAT_THREAD_META_STORE = "chat_thread_agents";

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

function expectLegacyStoreNotCreated(
  createObjectStore: ReturnType<typeof fakeDb>["createObjectStore"],
): void {
  expect(
    createObjectStore.mock.calls.map(([storeName]) => {
      return storeName;
    }),
  ).not.toContain(LEGACY_CHAT_THREAD_META_STORE);
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
  ).toHaveBeenCalledWith("byThreadAndTime", ["threadId", "createdAt"]);
  expect(
    createdStores.get(CHAT_MESSAGES_STORE)?.createIndex,
  ).toHaveBeenCalledWith(CHAT_MESSAGES_ORDER_INDEX, [
    "threadId",
    "createdAt",
    "orderSequence",
    "id",
  ]);
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

function expectThreadEventStoresDeleted(
  deleteObjectStore: ReturnType<typeof fakeDb>["deleteObjectStore"],
): void {
  expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_THREAD_SNAPSHOT_STORE);
  expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_THREAD_EVENTS_STORE);
  expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_THREAD_EVENT_SYNC_STORE);
}

function expectArtifactItemsStoreCreated(
  createdStores: ReturnType<typeof fakeDb>["createdStores"],
  createObjectStore: ReturnType<typeof fakeDb>["createObjectStore"],
): void {
  expect(createObjectStore).toHaveBeenCalledWith(ARTIFACT_ITEMS_STORE, {
    keyPath: "artifactItemId",
  });
  expect(
    createdStores.get(ARTIFACT_ITEMS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_CREATED_AT_INDEX, [
    "createdAt",
    "artifactItemId",
  ]);
  expect(
    createdStores.get(ARTIFACT_ITEMS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_AGENT_CREATED_AT_INDEX, [
    "agentId",
    "createdAt",
    "artifactItemId",
  ]);
  expect(
    createdStores.get(ARTIFACT_ITEMS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_KIND_CREATED_AT_INDEX, [
    "artifactKind",
    "createdAt",
    "artifactItemId",
  ]);
  expect(
    createdStores.get(ARTIFACT_ITEMS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_AGENT_KIND_CREATED_AT_INDEX, [
    "agentId",
    "artifactKind",
    "createdAt",
    "artifactItemId",
  ]);
  expect(
    createdStores.get(ARTIFACT_ITEMS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_RUN_FILE_INDEX, ["runId", "fileId"]);
}

function expectArtifactSyncStoreCreated(
  createObjectStore: ReturnType<typeof fakeDb>["createObjectStore"],
): void {
  expect(createObjectStore).toHaveBeenCalledWith(ARTIFACT_SYNC_STORE, {
    keyPath: "id",
  });
}

function expectAllLocalCacheStoresDeleted(
  deleteObjectStore: ReturnType<typeof fakeDb>["deleteObjectStore"],
): void {
  expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
  expectThreadEventStoresDeleted(deleteObjectStore);
  expect(deleteObjectStore).toHaveBeenCalledWith(ARTIFACT_ITEMS_STORE);
}

describe("upgradeChatIdb", () => {
  it("clears legacy chat cache when upgrading from before v4", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      LEGACY_CHAT_THREAD_META_STORE,
    ]);

    upgradeChatIdb(db, 3);

    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
    expect(deleteObjectStore).toHaveBeenCalledWith(
      LEGACY_CHAT_THREAD_META_STORE,
    );
    expectLegacyStoreNotCreated(createObjectStore);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("drops legacy thread metadata when resetting v4 messages for the order index", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      LEGACY_CHAT_THREAD_META_STORE,
    ]);

    upgradeChatIdb(db, 4);

    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
    expect(deleteObjectStore).toHaveBeenCalledWith(
      LEGACY_CHAT_THREAD_META_STORE,
    );
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectLegacyStoreNotCreated(createObjectStore);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("drops legacy thread metadata when resetting v5 messages for terminal marker ordering", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      LEGACY_CHAT_THREAD_META_STORE,
    ]);

    upgradeChatIdb(db, 5);

    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
    expect(deleteObjectStore).toHaveBeenCalledWith(
      LEGACY_CHAT_THREAD_META_STORE,
    );
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectLegacyStoreNotCreated(createObjectStore);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });
});

describe("upgradeChatIdb local cache resets", () => {
  it("resets v9 chat caches so cached unread calculations include run-finish markers", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 9);

    expect(deleteObjectStore).toHaveBeenCalledTimes(4);
    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
    expectThreadEventStoresDeleted(deleteObjectStore);
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("resets v10 chat, thread, and event caches", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 10);

    expect(deleteObjectStore).toHaveBeenCalledTimes(4);
    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
    expectThreadEventStoresDeleted(deleteObjectStore);
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("resets v11 local cache data during the v13 cache reset", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 11);

    expect(deleteObjectStore).toHaveBeenCalledTimes(4);
    expect(deleteObjectStore).toHaveBeenCalledWith(CHAT_MESSAGES_STORE);
    expectThreadEventStoresDeleted(deleteObjectStore);
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("resets v13 local cache data and recreates empty stores", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
    ]);

    upgradeChatIdb(db, 13);

    expect(deleteObjectStore).toHaveBeenCalledTimes(5);
    expectAllLocalCacheStoresDeleted(deleteObjectStore);
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("resets artifact items and adds the sync store when upgrading from v14", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
    ]);

    upgradeChatIdb(db, 14);

    expect(deleteObjectStore).toHaveBeenCalledTimes(1);
    expect(deleteObjectStore).toHaveBeenCalledWith(ARTIFACT_ITEMS_STORE);
    expect(createObjectStore).toHaveBeenCalledTimes(2);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("resets artifact caches when upgrading from v15", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
      ARTIFACT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 15);

    expect(deleteObjectStore).toHaveBeenCalledTimes(2);
    expect(deleteObjectStore).toHaveBeenCalledWith(ARTIFACT_ITEMS_STORE);
    expect(deleteObjectStore).toHaveBeenCalledWith(ARTIFACT_SYNC_STORE);
    expect(createObjectStore).toHaveBeenCalledTimes(2);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });
});
