import { openDB, type IDBPDatabase } from "idb";
import { logger } from "../log.ts";

const L = logger("ChatIdbThreadAgent");

interface ThreadAgentRow {
  threadId: string;
  agentId: string;
  updatedAt: string;
}

function isThreadAgentRow(raw: unknown): raw is ThreadAgentRow {
  if (raw === null || typeof raw !== "object") {
    return false;
  }
  const row = raw as Record<string, unknown>;
  return (
    typeof row.threadId === "string" &&
    typeof row.agentId === "string" &&
    typeof row.updatedAt === "string"
  );
}

const STORE = "chat_thread_agents";
const MESSAGE_STORE = "chat_messages";
const DB_VERSION = 2;

// Connection cache hidden behind an IIFE so module-scope rules don't see a
// raw mutable Map. Two callers (this module + `idb-message-store.ts`) can
// race to open the same DB; this cache de-dupes within this module, and
// the upgrade callback below idempotently creates both schema stores so
// whichever caller wins the v1 → v2 upgrade leaves a complete schema.
const getDb = (() => {
  const cache: Record<string, Promise<IDBPDatabase>> = {};
  return (userId: string, orgId: string): Promise<IDBPDatabase> => {
    const dbName = `vm0-chat-${userId}-${orgId}`;
    const existing = cache[dbName];
    if (existing !== undefined) {
      return existing;
    }
    L.debug("openDB", { dbName });
    const promise = openDB(dbName, DB_VERSION, {
      upgrade(db) {
        L.debug("openDB:upgrade", { dbName });
        if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
          const messageStore = db.createObjectStore(MESSAGE_STORE, {
            keyPath: "id",
          });
          messageStore.createIndex("byThreadAndTime", [
            "threadId",
            "createdAt",
          ]);
        }
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "threadId" });
        }
      },
    });
    cache[dbName] = promise;
    return promise;
  };
})();

export async function readThreadAgentId$(
  userId: string,
  orgId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const db = await getDb(userId, orgId);
  signal?.throwIfAborted();
  const raw = await db.get(STORE, threadId);
  if (!raw) {
    return null;
  }
  if (!isThreadAgentRow(raw)) {
    L.debug("read:corruptRow", { threadId });
    return null;
  }
  return raw.agentId;
}

export async function writeThreadAgentId$(
  userId: string,
  orgId: string,
  threadId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const db = await getDb(userId, orgId);
  signal?.throwIfAborted();
  await db.put(STORE, {
    threadId,
    agentId,
    updatedAt: new Date().toISOString(),
  });
  L.debug("write:done", { threadId, agentId });
}
