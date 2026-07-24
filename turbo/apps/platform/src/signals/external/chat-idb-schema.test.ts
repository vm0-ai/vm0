import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_ITEMS_AGENT_UPDATED_AT_INDEX,
  ARTIFACT_ITEMS_RUN_HOSTED_INDEX,
  ARTIFACT_ITEMS_STORE,
  ARTIFACT_ITEMS_UPDATED_AT_INDEX,
  ARTIFACT_ITEMS_URL_UPDATED_AT_INDEX,
  ARTIFACT_SYNC_STORE,
  CHAT_IDB_VERSION,
  CHAT_MESSAGES_ORDER_INDEX,
  CHAT_MESSAGES_STORE,
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
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_UPDATED_AT_INDEX, [
    "updatedAt",
    "createdAt",
    "artifactItemId",
  ]);
  expect(
    createdStores.get(ARTIFACT_ITEMS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_AGENT_UPDATED_AT_INDEX, [
    "agentId",
    "updatedAt",
    "createdAt",
    "artifactItemId",
  ]);
  expect(
    createdStores.get(ARTIFACT_ITEMS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_URL_UPDATED_AT_INDEX, [
    "url",
    "updatedAt",
    "createdAt",
    "artifactItemId",
  ]);
  expect(
    createdStores.get(ARTIFACT_ITEMS_STORE)?.createIndex,
  ).toHaveBeenCalledWith(ARTIFACT_ITEMS_RUN_HOSTED_INDEX, ["runId", "hosted"]);
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
  expect(deleteObjectStore).toHaveBeenCalledWith(ARTIFACT_SYNC_STORE);
}

describe("upgradeChatIdb local cache resets", () => {
  it("resets v13 local cache data and recreates empty stores", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
      ARTIFACT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 13);

    expect(deleteObjectStore).toHaveBeenCalledTimes(6);
    expectAllLocalCacheStoresDeleted(deleteObjectStore);
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("resets all local cache data when upgrading from v14", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
      ARTIFACT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 14);

    expect(deleteObjectStore).toHaveBeenCalledTimes(6);
    expectAllLocalCacheStoresDeleted(deleteObjectStore);
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("resets all local cache data when upgrading from v15", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
      ARTIFACT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 15);

    expect(deleteObjectStore).toHaveBeenCalledTimes(6);
    expectAllLocalCacheStoresDeleted(deleteObjectStore);
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("rebuilds all local caches with v18 indexes from v17", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
      ARTIFACT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 17);

    expect(deleteObjectStore).toHaveBeenCalledTimes(6);
    expectAllLocalCacheStoresDeleted(deleteObjectStore);
    expect(createObjectStore).toHaveBeenCalledTimes(6);
    expectChatMessagesStoreCreated(createdStores, createObjectStore);
    expectThreadEventStoresCreated(createdStores, createObjectStore);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("rebuilds only artifact caches when upgrading from v18", () => {
    const { db, createdStores, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
      ARTIFACT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, 18);

    expect(deleteObjectStore).toHaveBeenCalledTimes(2);
    expect(deleteObjectStore).toHaveBeenCalledWith(ARTIFACT_ITEMS_STORE);
    expect(deleteObjectStore).toHaveBeenCalledWith(ARTIFACT_SYNC_STORE);
    expect(createObjectStore).toHaveBeenCalledTimes(2);
    expectArtifactItemsStoreCreated(createdStores, createObjectStore);
    expectArtifactSyncStoreCreated(createObjectStore);
  });

  it("does not rebuild local caches at the current schema version", () => {
    const { db, createObjectStore, deleteObjectStore } = fakeDb([
      CHAT_MESSAGES_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      ARTIFACT_ITEMS_STORE,
      ARTIFACT_SYNC_STORE,
    ]);

    upgradeChatIdb(db, CHAT_IDB_VERSION);

    expect(deleteObjectStore).not.toHaveBeenCalled();
    expect(createObjectStore).not.toHaveBeenCalled();
  });
});
