import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type OpenDBCallbacks,
} from "idb";
import { logger } from "../log.ts";
import { CHAT_IDB_VERSION, upgradeChatIdb } from "./chat-idb-schema.ts";

const L = logger("ChatIdbStore");

type OpenChatIdbDatabase = <DBTypes extends DBSchema | unknown = unknown>(
  name: string,
  version?: number,
  callbacks?: OpenDBCallbacks<DBTypes>,
) => Promise<IDBPDatabase<DBTypes>>;

interface ChatIdbStoreState {
  readonly dbPromises: Map<string, Promise<IDBPDatabase>>;
  reloadTriggered: boolean;
}

interface ChatIdbStoreOptions {
  readonly openDatabase?: OpenChatIdbDatabase;
  readonly reload?: () => void;
}

interface ChatIdbStore {
  readonly openChatIdb: (
    userId: string,
    orgId: string,
  ) => Promise<IDBPDatabase>;
}

function chatIdbName(userId: string, orgId: string): string {
  return `vm0-chat-${userId}-${orgId}`;
}

export function createChatIdbStore(
  options: ChatIdbStoreOptions = {},
): ChatIdbStore {
  const openDatabase = options.openDatabase ?? openDB;
  const reload =
    options.reload ??
    (() => {
      window.location.reload();
    });
  const state: ChatIdbStoreState = {
    dbPromises: new Map(),
    reloadTriggered: false,
  };

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
    state.dbPromises.delete(dbName);

    if (state.reloadTriggered) {
      return;
    }
    state.reloadTriggered = true;
    reload();
  }

  async function openChatIdbConnection(dbName: string): Promise<IDBPDatabase> {
    const db = await openDatabase(dbName, CHAT_IDB_VERSION, {
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

  return {
    openChatIdb(userId, orgId) {
      if (state.reloadTriggered) {
        return Promise.reject(
          new Error("Chat IndexedDB is closing for a page reload"),
        );
      }

      const dbName = chatIdbName(userId, orgId);
      const existing = state.dbPromises.get(dbName);
      if (existing !== undefined) {
        return existing;
      }

      L.debug("openDB", { dbName });
      const promise = openChatIdbConnection(dbName);
      state.dbPromises.set(dbName, promise);
      return promise;
    },
  };
}

const defaultChatIdbStore = createChatIdbStore();

export const openChatIdb = defaultChatIdbStore.openChatIdb;
