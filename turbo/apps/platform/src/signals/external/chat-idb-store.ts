import { openDB, type IDBPDatabase } from "idb";
import { logger } from "../log.ts";
import { CHAT_IDB_VERSION, upgradeChatIdb } from "./chat-idb-schema.ts";

const L = logger("ChatIdbStore");

interface ChatIdbStoreState {
  readonly dbPromises: Map<string, Promise<IDBPDatabase>>;
  reloadTriggered: boolean;
}

function createChatIdbStoreState(): ChatIdbStoreState {
  return {
    dbPromises: new Map(),
    reloadTriggered: false,
  };
}

const chatIdbStoreState = createChatIdbStoreState();

function chatIdbName(userId: string, orgId: string): string {
  return `vm0-chat-${userId}-${orgId}`;
}

function handleVersionChange(
  dbName: string,
  db: IDBPDatabase,
  event: IDBVersionChangeEvent,
): void {
  L.warn("versionchange", {
    dbName,
    currentVersion: event.oldVersion,
    nextVersion: event.newVersion,
  });
  db.close();
  chatIdbStoreState.dbPromises.delete(dbName);

  if (chatIdbStoreState.reloadTriggered) {
    return;
  }
  chatIdbStoreState.reloadTriggered = true;
  window.location.reload();
}

export function openChatIdb(
  userId: string,
  orgId: string,
): Promise<IDBPDatabase> {
  const dbName = chatIdbName(userId, orgId);
  const existing = chatIdbStoreState.dbPromises.get(dbName);
  if (existing !== undefined) {
    return existing;
  }

  if (chatIdbStoreState.reloadTriggered) {
    return Promise.reject(
      new Error("Chat IndexedDB is closing for a page reload"),
    );
  }

  L.debug("openDB", { dbName });
  const promise = openChatIdbConnection(dbName);
  chatIdbStoreState.dbPromises.set(dbName, promise);
  return promise;
}

async function openChatIdbConnection(dbName: string): Promise<IDBPDatabase> {
  const db = await openDB(dbName, CHAT_IDB_VERSION, {
    upgrade(db, oldVersion) {
      L.debug("openDB:upgrade", { dbName });
      upgradeChatIdb(db, oldVersion);
    },
    blocked(currentVersion, blockedVersion) {
      L.warn("openDB:blocked", { dbName, currentVersion, blockedVersion });
    },
  });
  db.addEventListener("versionchange", (event) => {
    handleVersionChange(dbName, db, event);
  });
  return db;
}
