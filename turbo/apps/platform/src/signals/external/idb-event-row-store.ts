import type { IDBPDatabase } from "idb";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { logger } from "../log.ts";
import { onRejection } from "../utils.ts";
import {
  CHAT_EVENT_ROWS_ORDER_INDEX,
  CHAT_EVENT_ROWS_STORE,
  CHAT_EVENT_CURSOR_STORE,
} from "./chat-idb-schema.ts";
import { disabledChatIdbError, logChatIdbDisabled } from "./chat-idb-safe.ts";

const L = logger("ChatEventRowIndexedDb");

interface ChatEventRowReadStore {
  readCursors(
    threadIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, ChatEventCursor>>;
  readCursor(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ChatEventCursor | null>;
  readRowsAfter(
    threadId: string,
    afterSeqId: number | null,
    signal?: AbortSignal,
  ): Promise<ChatEventRow[]>;
}

interface ChatEventRowWriteStore {
  upsertRowsAndCursors(
    entries: readonly {
      readonly threadId: string;
      readonly rows: readonly ChatEventRow[];
      readonly cursor: ChatEventCursor;
    }[],
    signal?: AbortSignal,
  ): Promise<void>;
  upsertRowsAndCursor(
    threadId: string,
    rows: readonly ChatEventRow[],
    cursor: ChatEventCursor,
    signal?: AbortSignal,
  ): Promise<void>;
  replaceRowsAndCursor(
    threadId: string,
    rows: readonly ChatEventRow[],
    cursor: ChatEventCursor,
    signal?: AbortSignal,
  ): Promise<void>;
  clearThread(threadId: string, signal?: AbortSignal): Promise<void>;
}

// The store persists only strict canonical rows. Its introducing schema
// upgrade dropped the previous raw-row cache before rebuilding it.
function storedChatEventRow(raw: unknown): ChatEventRow {
  return chatEventRowSchema.parse(raw);
}

function storedChatEventCursor(raw: unknown): ChatEventCursor {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("schemaVersion" in raw) ||
    raw.schemaVersion !== CURRENT_CHAT_EVENT_SCHEMA_VERSION ||
    !("lastEventId" in raw) ||
    !("lastSeqId" in raw) ||
    typeof raw.lastSeqId !== "number" ||
    !Number.isSafeInteger(raw.lastSeqId) ||
    raw.lastSeqId < 0
  ) {
    throw new Error("Invalid cached Chat Event cursor");
  }
  if (raw.lastEventId === null) {
    if (raw.lastSeqId !== 0) {
      throw new Error("Invalid cached Chat Event cursor");
    }
    return { lastEventId: null, lastSeqId: 0 };
  }
  if (typeof raw.lastEventId !== "string" || raw.lastSeqId === 0) {
    throw new Error("Invalid cached Chat Event cursor");
  }
  return {
    lastEventId: raw.lastEventId,
    lastSeqId: raw.lastSeqId,
  };
}

function threadRowRange(
  threadId: string,
  afterSeqId: number | null,
): IDBKeyRange {
  if (afterSeqId === null) {
    return IDBKeyRange.bound([threadId], [threadId, []]);
  }
  return IDBKeyRange.bound([threadId, afterSeqId], [threadId, []], true, false);
}

type GetDb = () => Promise<IDBPDatabase>;

function createRowReadStore(
  storeName: string,
  cursorStoreName: string,
  getDb: GetDb,
): ChatEventRowReadStore {
  return {
    async readCursors(threadIds, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(cursorStoreName, "readonly");
      const rawCursors = await Promise.all(
        threadIds.map((threadId) => {
          return tx.store.get(threadId);
        }),
      );
      signal?.throwIfAborted();
      const cursors = new Map<string, ChatEventCursor>();
      for (const [index, rawCursor] of rawCursors.entries()) {
        if (rawCursor !== undefined) {
          const threadId = threadIds[index];
          if (threadId === undefined) {
            throw new Error("Chat Event cursor batch index is invalid");
          }
          cursors.set(threadId, storedChatEventCursor(rawCursor));
        }
      }
      return cursors;
    },
    async readCursor(threadId, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(cursorStoreName, "readonly");
      const cursor = await tx.store.get(threadId);
      signal?.throwIfAborted();
      return cursor === undefined ? null : storedChatEventCursor(cursor);
    },
    async readRowsAfter(threadId, afterSeqId, signal) {
      L.debug("readRowsAfter:start", { threadId, afterSeqId });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction([storeName, cursorStoreName], "readonly");
      const rawCursor = await tx.objectStore(cursorStoreName).get(threadId);
      signal?.throwIfAborted();
      if (rawCursor === undefined) {
        return [];
      }
      // A cursor versions the whole row generation. Reject it before exposing
      // rows so a retired cache shape cannot enter the current row stream.
      storedChatEventCursor(rawCursor);
      const index = tx
        .objectStore(storeName)
        .index(CHAT_EVENT_ROWS_ORDER_INDEX);
      const storedRows = await index.getAll(
        threadRowRange(threadId, afterSeqId),
      );
      signal?.throwIfAborted();
      const rows = storedRows.map(storedChatEventRow);
      L.debug("readRowsAfter:done", { threadId, count: rows.length });
      return rows;
    },
  };
}

function createRowWriteStore(
  storeName: string,
  cursorStoreName: string,
  getDb: GetDb,
): ChatEventRowWriteStore {
  return {
    async upsertRowsAndCursors(entries, signal) {
      if (entries.length === 0) {
        return;
      }
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction([storeName, cursorStoreName], "readwrite");
      const rowStore = tx.objectStore(storeName);
      const cursorStore = tx.objectStore(cursorStoreName);
      const requests = entries.flatMap((entry) => {
        signal?.throwIfAborted();
        return [
          ...entry.rows.map((row) => {
            return rowStore.put(row);
          }),
          cursorStore.put({
            threadId: entry.threadId,
            schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
            lastEventId: entry.cursor.lastEventId,
            lastSeqId: entry.cursor.lastSeqId,
          }),
        ];
      });
      await Promise.all([...requests, tx.done]);
      L.debug("upsertRowsAndCursors:done", {
        threadCount: entries.length,
        rowCount: entries.reduce((count, entry) => {
          return count + entry.rows.length;
        }, 0),
      });
    },
    async upsertRowsAndCursor(threadId, rows, cursor, signal) {
      L.debug("upsertRows:start", { count: rows.length });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction([storeName, cursorStoreName], "readwrite");
      const rowStore = tx.objectStore(storeName);
      const requests = rows.map((row) => {
        signal?.throwIfAborted();
        return rowStore.put(row);
      });
      requests.push(
        tx.objectStore(cursorStoreName).put({
          threadId,
          schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          lastEventId: cursor.lastEventId,
          lastSeqId: cursor.lastSeqId,
        }),
      );
      await Promise.all([...requests, tx.done]);
      L.debug("upsertRows:done", { count: rows.length });
    },
    async replaceRowsAndCursor(threadId, rows, cursor, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction([storeName, cursorStoreName], "readwrite");
      const rowStore = tx.objectStore(storeName);
      const index = rowStore.index(CHAT_EVENT_ROWS_ORDER_INDEX);
      const keys = await index.getAllKeys(threadRowRange(threadId, null));
      signal?.throwIfAborted();
      const deleteRequests = keys.map((key) => {
        return rowStore.delete(key);
      });
      const putRequests = rows.map((row) => {
        signal?.throwIfAborted();
        return rowStore.put(row);
      });
      await Promise.all([
        ...deleteRequests,
        ...putRequests,
        tx.objectStore(cursorStoreName).put({
          threadId,
          schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          lastEventId: cursor.lastEventId,
          lastSeqId: cursor.lastSeqId,
        }),
        tx.done,
      ]);
      L.debug("replaceRows:done", {
        threadId,
        deletedCount: keys.length,
        count: rows.length,
      });
    },
    async clearThread(threadId, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction([storeName, cursorStoreName], "readwrite");
      const rowStore = tx.objectStore(storeName);
      const index = rowStore.index(CHAT_EVENT_ROWS_ORDER_INDEX);
      const keys = await index.getAllKeys(threadRowRange(threadId, null));
      signal?.throwIfAborted();
      const requests = keys.map((key) => {
        return rowStore.delete(key);
      });
      requests.push(tx.objectStore(cursorStoreName).delete(threadId));
      await Promise.all([...requests, tx.done]);
      L.debug("clearThread:done", { threadId, count: keys.length });
    },
  };
}

function createIdbEventRowStores(getChatIdb: GetDb) {
  const dbName = "current chat IndexedDB";
  const storeName = CHAT_EVENT_ROWS_STORE;
  const cursorStoreName = CHAT_EVENT_CURSOR_STORE;

  let disabled = false;

  function disableForSession(reason: unknown): void {
    if (disabled) {
      return;
    }
    disabled = true;
    logChatIdbDisabled(dbName, reason);
  }

  async function getDb(): Promise<IDBPDatabase> {
    if (disabled) {
      throw disabledChatIdbError(dbName);
    }

    // IDB open is a cache fast path; rejection disables it for this tab.
    return await onRejection(getChatIdb(), disableForSession);
  }

  return Object.freeze({
    readStore: createRowReadStore(storeName, cursorStoreName, getDb),
    writeStore: createRowWriteStore(storeName, cursorStoreName, getDb),
  });
}

export { createIdbEventRowStores };
