import type { IDBPDatabase } from "idb";

const CHAT_IDB_FULL_CACHE_RESET_VERSION = 4;
const CHAT_IDB_MESSAGES_ORDER_RESET_VERSION = 6;
const CHAT_IDB_SCHEMA_VERSION = 8;

export const CHAT_IDB_VERSION = CHAT_IDB_SCHEMA_VERSION;
export const CHAT_MESSAGES_STORE = "chat_messages";
export const CHAT_THREAD_META_STORE = "chat_thread_agents";
export const CHAT_THREAD_SNAPSHOT_STORE = "chat_thread_snapshot";
export const CHAT_THREAD_EVENTS_STORE = "chat_thread_events";
export const CHAT_THREAD_EVENT_SYNC_STORE = "chat_thread_event_sync";
export const CHAT_MESSAGES_ORDER_INDEX = "byThreadAndOrder";
export const CHAT_THREAD_EVENTS_ORDER_INDEX = "byCreatedAt";

function createChatMessagesStore(db: IDBPDatabase): void {
  const store = db.createObjectStore(CHAT_MESSAGES_STORE, { keyPath: "id" });
  store.createIndex("byThreadAndTime", ["threadId", "createdAt"]);
  store.createIndex(CHAT_MESSAGES_ORDER_INDEX, [
    "threadId",
    "createdAt",
    "orderSequence",
    "id",
  ]);
}

function createThreadMetaStore(db: IDBPDatabase): void {
  db.createObjectStore(CHAT_THREAD_META_STORE, { keyPath: "threadId" });
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

export function upgradeChatIdb(db: IDBPDatabase, oldVersion: number): void {
  if (oldVersion < CHAT_IDB_FULL_CACHE_RESET_VERSION) {
    if (db.objectStoreNames.contains(CHAT_MESSAGES_STORE)) {
      db.deleteObjectStore(CHAT_MESSAGES_STORE);
    }
    if (db.objectStoreNames.contains(CHAT_THREAD_META_STORE)) {
      db.deleteObjectStore(CHAT_THREAD_META_STORE);
    }
  } else if (oldVersion < CHAT_IDB_MESSAGES_ORDER_RESET_VERSION) {
    if (db.objectStoreNames.contains(CHAT_MESSAGES_STORE)) {
      db.deleteObjectStore(CHAT_MESSAGES_STORE);
    }
  }

  if (!db.objectStoreNames.contains(CHAT_MESSAGES_STORE)) {
    createChatMessagesStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_META_STORE)) {
    createThreadMetaStore(db);
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
}
