import type { IDBPDatabase } from "idb";

const CHAT_IDB_SEQ_ID_RESET_VERSION = 18;
// The artifacts page reads its pages straight from the artifact catalog API, so
// the mirrored artifact history is gone. Bumping the version drops the stores
// from browser databases that still carry a full history from the old page.
const ARTIFACT_CACHE_REMOVED_VERSION = 20;
const CHAT_IDB_CHAT_EVENT_RESET_VERSION = 21;
const CHAT_IDB_THREAD_EVENT_SEQ_ID_RESET_VERSION = 22;
// userMessage is now the only source for persisted user-input rendering.
// Rebuild every chat event cache so documents written by older App bundles
// cannot reintroduce content-only events after the server migration.
const CHAT_IDB_USER_MESSAGE_READ_CUTOVER_VERSION = 23;
// input.prompt and input.rejected now require content=null. Rebuild persisted
// event caches so strict reads cannot encounter the retired input projection.
const CHAT_IDB_INPUT_CONTENT_REMOVAL_VERSION = 24;
const CHAT_IDB_SCHEMA_VERSION = CHAT_IDB_INPUT_CONTENT_REMOVAL_VERSION;
const LEGACY_CHAT_THREAD_META_STORE = "chat_thread_agents";
const LEGACY_ARTIFACT_ITEMS_STORE = "artifact_items";
const LEGACY_ARTIFACT_SYNC_STORE = "artifact_sync";

export const CHAT_IDB_VERSION = CHAT_IDB_SCHEMA_VERSION;
export const CHAT_MESSAGES_STORE = "chat_messages";
export const CHAT_THREAD_SNAPSHOT_STORE = "chat_thread_snapshot";
export const CHAT_THREAD_EVENTS_STORE = "chat_thread_events";
export const CHAT_THREAD_EVENT_SYNC_STORE = "chat_thread_event_sync";
export const CHAT_MESSAGES_ORDER_INDEX = "byThreadAndOrder";
export const CHAT_THREAD_EVENTS_ORDER_INDEX = "bySeqId";

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
  store.createIndex(CHAT_THREAD_EVENTS_ORDER_INDEX, "seqId", {
    unique: true,
  });
}

function createChatThreadEventSyncStore(db: IDBPDatabase): void {
  db.createObjectStore(CHAT_THREAD_EVENT_SYNC_STORE, { keyPath: "id" });
}

function deleteObjectStoreIfExists(db: IDBPDatabase, storeName: string): void {
  if (db.objectStoreNames.contains(storeName)) {
    db.deleteObjectStore(storeName);
  }
}

function deleteLocalCacheStores(db: IDBPDatabase): void {
  deleteObjectStoreIfExists(db, CHAT_MESSAGES_STORE);
  deleteChatThreadEventStores(db);
  deleteArtifactCacheStores(db);
  deleteObjectStoreIfExists(db, LEGACY_CHAT_THREAD_META_STORE);
}

function deleteChatThreadEventStores(db: IDBPDatabase): void {
  deleteObjectStoreIfExists(db, CHAT_THREAD_SNAPSHOT_STORE);
  deleteObjectStoreIfExists(db, CHAT_THREAD_EVENTS_STORE);
  deleteObjectStoreIfExists(db, CHAT_THREAD_EVENT_SYNC_STORE);
}

function deleteArtifactCacheStores(db: IDBPDatabase): void {
  deleteObjectStoreIfExists(db, LEGACY_ARTIFACT_ITEMS_STORE);
  deleteObjectStoreIfExists(db, LEGACY_ARTIFACT_SYNC_STORE);
}

export function upgradeChatIdb(db: IDBPDatabase, oldVersion: number): void {
  if (oldVersion < CHAT_IDB_SEQ_ID_RESET_VERSION) {
    deleteLocalCacheStores(db);
  } else if (oldVersion < ARTIFACT_CACHE_REMOVED_VERSION) {
    deleteArtifactCacheStores(db);
  }

  if (oldVersion < CHAT_IDB_CHAT_EVENT_RESET_VERSION) {
    deleteObjectStoreIfExists(db, CHAT_MESSAGES_STORE);
  }

  if (oldVersion < CHAT_IDB_THREAD_EVENT_SEQ_ID_RESET_VERSION) {
    deleteChatThreadEventStores(db);
  }

  if (oldVersion < CHAT_IDB_USER_MESSAGE_READ_CUTOVER_VERSION) {
    deleteObjectStoreIfExists(db, CHAT_MESSAGES_STORE);
    deleteChatThreadEventStores(db);
  }

  if (oldVersion < CHAT_IDB_INPUT_CONTENT_REMOVAL_VERSION) {
    deleteObjectStoreIfExists(db, CHAT_MESSAGES_STORE);
    deleteChatThreadEventStores(db);
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
}
