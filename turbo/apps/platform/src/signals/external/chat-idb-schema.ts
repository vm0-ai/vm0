import type { IDBPDatabase } from "idb";

const CHAT_IDB_SEQ_ID_RESET_VERSION = 18;
const CHAT_IDB_SCHEMA_VERSION = CHAT_IDB_SEQ_ID_RESET_VERSION;
const LEGACY_CHAT_THREAD_META_STORE = "chat_thread_agents";

export const CHAT_IDB_VERSION = CHAT_IDB_SCHEMA_VERSION;
export const CHAT_MESSAGES_STORE = "chat_messages";
export const CHAT_THREAD_SNAPSHOT_STORE = "chat_thread_snapshot";
export const CHAT_THREAD_EVENTS_STORE = "chat_thread_events";
export const CHAT_THREAD_EVENT_SYNC_STORE = "chat_thread_event_sync";
export const ARTIFACT_ITEMS_STORE = "artifact_items";
export const ARTIFACT_SYNC_STORE = "artifact_sync";
export const CHAT_MESSAGES_ORDER_INDEX = "byThreadAndOrder";
export const CHAT_THREAD_EVENTS_ORDER_INDEX = "byCreatedAt";
export const ARTIFACT_ITEMS_UPDATED_AT_INDEX = "byUpdatedAt";
export const ARTIFACT_ITEMS_AGENT_UPDATED_AT_INDEX = "byAgentUpdatedAt";
export const ARTIFACT_ITEMS_URL_UPDATED_AT_INDEX = "byUrlUpdatedAt";
export const ARTIFACT_ITEMS_RUN_HOSTED_INDEX = "byRunHosted";

function createChatMessagesStore(db: IDBPDatabase): void {
  const store = db.createObjectStore(CHAT_MESSAGES_STORE, { keyPath: "id" });
  store.createIndex(CHAT_MESSAGES_ORDER_INDEX, ["threadId", "seqId"], {
    unique: true,
  });
}

function createChatThreadSnapshotStore(db: IDBPDatabase): void {
  db.createObjectStore(CHAT_THREAD_SNAPSHOT_STORE, { keyPath: "id" });
}

function createChatThreadEventsStore(db: IDBPDatabase): void {
  const store = db.createObjectStore(CHAT_THREAD_EVENTS_STORE, {
    keyPath: "id",
  });
  store.createIndex(CHAT_THREAD_EVENTS_ORDER_INDEX, ["createdAt", "id"]);
}

function createChatThreadEventSyncStore(db: IDBPDatabase): void {
  db.createObjectStore(CHAT_THREAD_EVENT_SYNC_STORE, { keyPath: "id" });
}

function createArtifactItemsStore(db: IDBPDatabase): void {
  const store = db.createObjectStore(ARTIFACT_ITEMS_STORE, {
    keyPath: "artifactItemId",
  });
  store.createIndex(ARTIFACT_ITEMS_UPDATED_AT_INDEX, [
    "updatedAt",
    "createdAt",
    "artifactItemId",
  ]);
  store.createIndex(ARTIFACT_ITEMS_AGENT_UPDATED_AT_INDEX, [
    "agentId",
    "updatedAt",
    "createdAt",
    "artifactItemId",
  ]);
  store.createIndex(ARTIFACT_ITEMS_URL_UPDATED_AT_INDEX, [
    "url",
    "updatedAt",
    "createdAt",
    "artifactItemId",
  ]);
  store.createIndex(ARTIFACT_ITEMS_RUN_HOSTED_INDEX, ["runId", "hosted"]);
}

function createArtifactSyncStore(db: IDBPDatabase): void {
  db.createObjectStore(ARTIFACT_SYNC_STORE, { keyPath: "id" });
}

function deleteObjectStoreIfExists(db: IDBPDatabase, storeName: string): void {
  if (db.objectStoreNames.contains(storeName)) {
    db.deleteObjectStore(storeName);
  }
}

function deleteLocalCacheStores(db: IDBPDatabase): void {
  deleteObjectStoreIfExists(db, CHAT_MESSAGES_STORE);
  deleteObjectStoreIfExists(db, CHAT_THREAD_SNAPSHOT_STORE);
  deleteObjectStoreIfExists(db, CHAT_THREAD_EVENTS_STORE);
  deleteObjectStoreIfExists(db, CHAT_THREAD_EVENT_SYNC_STORE);
  deleteObjectStoreIfExists(db, ARTIFACT_ITEMS_STORE);
  deleteObjectStoreIfExists(db, ARTIFACT_SYNC_STORE);
  deleteObjectStoreIfExists(db, LEGACY_CHAT_THREAD_META_STORE);
}

export function upgradeChatIdb(db: IDBPDatabase, oldVersion: number): void {
  if (oldVersion < CHAT_IDB_SEQ_ID_RESET_VERSION) {
    deleteLocalCacheStores(db);
  }

  if (!db.objectStoreNames.contains(CHAT_MESSAGES_STORE)) {
    createChatMessagesStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_SNAPSHOT_STORE)) {
    createChatThreadSnapshotStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_EVENTS_STORE)) {
    createChatThreadEventsStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_EVENT_SYNC_STORE)) {
    createChatThreadEventSyncStore(db);
  }
  if (!db.objectStoreNames.contains(ARTIFACT_ITEMS_STORE)) {
    createArtifactItemsStore(db);
  }
  if (!db.objectStoreNames.contains(ARTIFACT_SYNC_STORE)) {
    createArtifactSyncStore(db);
  }
}
