import type { IDBPDatabase } from "idb";

const CHAT_IDB_CACHE_RESET_VERSION = 4;

export const CHAT_IDB_VERSION = 4;
export const CHAT_MESSAGES_STORE = "chat_messages";
export const CHAT_THREAD_META_STORE = "chat_thread_agents";

function createChatMessagesStore(db: IDBPDatabase): void {
  const store = db.createObjectStore(CHAT_MESSAGES_STORE, { keyPath: "id" });
  store.createIndex("byThreadAndTime", ["threadId", "createdAt"]);
}

function createThreadMetaStore(db: IDBPDatabase): void {
  db.createObjectStore(CHAT_THREAD_META_STORE, { keyPath: "threadId" });
}

export function upgradeChatIdb(db: IDBPDatabase, oldVersion: number): void {
  if (oldVersion < CHAT_IDB_CACHE_RESET_VERSION) {
    if (db.objectStoreNames.contains(CHAT_MESSAGES_STORE)) {
      db.deleteObjectStore(CHAT_MESSAGES_STORE);
    }
    if (db.objectStoreNames.contains(CHAT_THREAD_META_STORE)) {
      db.deleteObjectStore(CHAT_THREAD_META_STORE);
    }
  }

  if (!db.objectStoreNames.contains(CHAT_MESSAGES_STORE)) {
    createChatMessagesStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_META_STORE)) {
    createThreadMetaStore(db);
  }
}
