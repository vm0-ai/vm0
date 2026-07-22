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

interface ChatIdbOpenerOptions {
  readonly openDatabase?: OpenChatIdbDatabase;
  readonly reload?: () => void;
}

interface ChatIdbOpener {
  readonly openChatIdb: (
    userId: string,
    orgId: string,
  ) => Promise<IDBPDatabase>;
}

function chatIdbName(userId: string, orgId: string): string {
  return `vm0-chat-${userId}-${orgId}`;
}

export function createChatIdbOpener(
  options: ChatIdbOpenerOptions = {},
): ChatIdbOpener {
  const openDatabase = options.openDatabase ?? openDB;
  const reload =
    options.reload ??
    (() => {
      window.location.reload();
    });

  return {
    async openChatIdb(userId, orgId) {
      const dbName = chatIdbName(userId, orgId);
      L.debug("openDB", { dbName });
      const db = await openDatabase(dbName, CHAT_IDB_VERSION, {
        upgrade(db, oldVersion) {
          L.debug("openDB:upgrade", { dbName });
          upgradeChatIdb(db, oldVersion);
        },
        blocked(currentVersion, blockedVersion) {
          L.warn("openDB:blocked", { dbName, currentVersion, blockedVersion });
        },
      });
      db.addEventListener(
        "versionchange",
        (event) => {
          L.warn("versionchange", {
            dbName,
            currentVersion: event.oldVersion,
            nextVersion: event.newVersion,
          });
          db.close();
          reload();
        },
        { once: true },
      );
      return db;
    },
  };
}

const defaultChatIdbOpener = createChatIdbOpener();

export const openChatIdb = defaultChatIdbOpener.openChatIdb;

export const chatIdb$ = computed(async (get): Promise<IDBPDatabase> => {
  const { userId, orgId } = await get(authenticatedIdentity$);
  return openChatIdb(userId, orgId);
});
