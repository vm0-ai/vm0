import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type OpenDBCallbacks,
} from "idb";
import { computed } from "ccstate";
import { authenticatedIdentity$ } from "../auth.ts";
import { logger } from "../log.ts";
import { CHAT_IDB_VERSION, upgradeChatIdb } from "./chat-idb-schema.ts";

const L = logger("ChatIdbStore");

type OpenChatIdbDatabase = <DBTypes extends DBSchema | unknown = unknown>(
  name: string,
  version?: number,
  callbacks?: OpenDBCallbacks<DBTypes>,
) => Promise<IDBPDatabase<DBTypes>>;

interface ChatIdbStoreState {
  dbName: string | null;
  dbPromise: Promise<IDBPDatabase> | null;
  previousClosePromise: Promise<void> | null;
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
    dbName: null,
    dbPromise: null,
    previousClosePromise: null,
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
    if (state.dbName === dbName) {
      state.dbName = null;
      state.dbPromise = null;
    }

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

  async function closeChatIdbAfterOpen(
    promise: Promise<IDBPDatabase>,
  ): Promise<void> {
    const [result] = await Promise.allSettled([promise]);
    if (result?.status === "fulfilled") {
      result.value.close();
    }
  }

  return {
    openChatIdb(userId, orgId) {
      if (state.reloadTriggered) {
        return Promise.reject(
          new Error("Chat IndexedDB is closing for a page reload"),
        );
      }

      const dbName = chatIdbName(userId, orgId);
      if (state.dbName === dbName && state.dbPromise !== null) {
        return state.dbPromise;
      }

      L.debug("openDB", { dbName });
      const previous = state.dbPromise;
      const promise = openChatIdbConnection(dbName);
      state.dbName = dbName;
      state.dbPromise = promise;
      if (previous !== null) {
        state.previousClosePromise = closeChatIdbAfterOpen(previous);
      }
      return promise;
    },
  };
}

const defaultChatIdbStore = createChatIdbStore();

export const openChatIdb = defaultChatIdbStore.openChatIdb;

export const chatIdb$ = computed(async (get): Promise<IDBPDatabase> => {
  const { userId, orgId } = await get(authenticatedIdentity$);
  return openChatIdb(userId, orgId);
});
