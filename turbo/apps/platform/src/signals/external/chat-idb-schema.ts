import type { IDBPDatabase, IDBPTransaction } from "idb";

const CHAT_IDB_CACHE_RESET_VERSION = 4;
const CHAT_IDB_ORDER_INDEX_VERSION = 5;

export const CHAT_IDB_VERSION = 5;
export const CHAT_MESSAGES_STORE = "chat_messages";
export const CHAT_THREAD_META_STORE = "chat_thread_agents";
export const CHAT_MESSAGES_ORDER_INDEX = "byThreadAndOrder";

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

export function upgradeChatIdb(
  db: IDBPDatabase,
  oldVersion: number,
  tx?: IDBPTransaction<unknown, string[], "versionchange">,
): void {
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
  } else if (oldVersion < CHAT_IDB_ORDER_INDEX_VERSION) {
    if (!tx) {
      throw new Error("chat IDB order index upgrade requires transaction");
    }
    tx.objectStore(CHAT_MESSAGES_STORE).createIndex(CHAT_MESSAGES_ORDER_INDEX, [
      "threadId",
      "createdAt",
      "orderSequence",
      "id",
    ]);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_META_STORE)) {
    createThreadMetaStore(db);
  }
}
