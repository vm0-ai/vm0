import { openDB, type IDBPDatabase } from "idb";
import { logger } from "../log.ts";

const L = logger("ChatIdbThreadMeta");

interface ThreadMeta {
  threadId: string;
  agentId: string | null;
  startMessageId: string | null;
  updatedAt: string;
}

interface ThreadMetaRow {
  threadId: string;
  agentId?: string;
  startMessageId?: string;
  updatedAt: string;
}

function isThreadMetaRow(raw: unknown): raw is ThreadMetaRow {
  if (raw === null || typeof raw !== "object") {
    return false;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.threadId !== "string" || typeof row.updatedAt !== "string") {
    return false;
  }
  if (row.agentId !== undefined && typeof row.agentId !== "string") {
    return false;
  }
  if (
    row.startMessageId !== undefined &&
    typeof row.startMessageId !== "string"
  ) {
    return false;
  }
  return true;
}

// IDB store name kept as `chat_thread_agents` for backward compatibility with
// existing v2 databases. The row schema is forward-compatible: older rows
// without `startMessageId` are still valid; new fields default to undefined.
const STORE = "chat_thread_agents";
const MESSAGE_STORE = "chat_messages";
const DB_VERSION = 2;

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

export async function readThreadMeta$(
  userId: string,
  orgId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadMeta | null> {
  const db = await getDb(userId, orgId);
  signal?.throwIfAborted();
  const raw = await db.get(STORE, threadId);
  if (!raw) {
    return null;
  }
  if (!isThreadMetaRow(raw)) {
    L.debug("read:corruptRow", { threadId });
    return null;
  }
  return {
    threadId: raw.threadId,
    agentId: raw.agentId ?? null,
    startMessageId: raw.startMessageId ?? null,
    updatedAt: raw.updatedAt,
  };
}

interface ThreadMetaPatch {
  agentId?: string;
  startMessageId?: string;
}

/**
 * Atomically merge `patch` into the existing row, preserving fields not
 * provided. Single readwrite transaction so concurrent patches don't drop
 * fields.
 */
export async function patchThreadMeta$(
  userId: string,
  orgId: string,
  threadId: string,
  patch: ThreadMetaPatch,
  signal?: AbortSignal,
): Promise<void> {
  const db = await getDb(userId, orgId);
  signal?.throwIfAborted();
  const tx = db.transaction(STORE, "readwrite");
  const existing = await tx.store.get(threadId);
  signal?.throwIfAborted();
  const current = isThreadMetaRow(existing) ? existing : null;
  const next: ThreadMetaRow = {
    threadId,
    agentId: patch.agentId ?? current?.agentId,
    startMessageId: patch.startMessageId ?? current?.startMessageId,
    updatedAt: new Date().toISOString(),
  };
  await tx.store.put(next);
  await tx.done;
  L.debug("patch:done", { threadId, patch });
}
