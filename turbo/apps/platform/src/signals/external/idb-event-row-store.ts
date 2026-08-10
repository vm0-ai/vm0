import type { IDBPDatabase } from "idb";
import {
  chatEventRowV4Schema,
  type ChatEventRowV4,
} from "@vm0/api-contracts/contracts/chat-event-rows";
import { logger } from "../log.ts";
import { onRejection } from "../utils.ts";
import {
  CHAT_EVENT_ROWS_ORDER_INDEX,
  CHAT_EVENT_ROWS_STORE,
} from "./chat-idb-schema.ts";
import { disabledChatIdbError, logChatIdbDisabled } from "./chat-idb-safe.ts";

const L = logger("ChatEventRowIndexedDb");

interface ChatEventRowReadStore {
  readLastSeqId(threadId: string, signal?: AbortSignal): Promise<number | null>;
  readRowsAfter(
    threadId: string,
    afterSeqId: number | null,
    signal?: AbortSignal,
  ): Promise<ChatEventRowV4[]>;
}

interface ChatEventRowWriteStore {
  upsertRows(
    rows: readonly ChatEventRowV4[],
    signal?: AbortSignal,
  ): Promise<void>;
  clearThread(threadId: string, signal?: AbortSignal): Promise<void>;
}

// The store persists only normalized canonical rows; the schema upgrade that
// introduced them dropped every store that still held raw v3 rows.
function storedChatEventRow(raw: unknown): ChatEventRowV4 {
  return chatEventRowV4Schema.parse(raw);
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
  getDb: GetDb,
): ChatEventRowReadStore {
  return {
    async readLastSeqId(threadId, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readonly");
      const index = tx.store.index(CHAT_EVENT_ROWS_ORDER_INDEX);
      const cursor = await index.openCursor(
        threadRowRange(threadId, null),
        "prev",
      );
      signal?.throwIfAborted();
      return cursor ? storedChatEventRow(cursor.value).seqId : null;
    },
    async readRowsAfter(threadId, afterSeqId, signal) {
      L.debug("readRowsAfter:start", { threadId, afterSeqId });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readonly");
      const index = tx.store.index(CHAT_EVENT_ROWS_ORDER_INDEX);
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
  getDb: GetDb,
): ChatEventRowWriteStore {
  return {
    async upsertRows(rows, signal) {
      L.debug("upsertRows:start", { count: rows.length });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readwrite");
      const requests = rows.map((row) => {
        signal?.throwIfAborted();
        return tx.store.put(row);
      });
      await Promise.all([...requests, tx.done]);
      L.debug("upsertRows:done", { count: rows.length });
    },
    async clearThread(threadId, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readwrite");
      const index = tx.store.index(CHAT_EVENT_ROWS_ORDER_INDEX);
      const keys = await index.getAllKeys(threadRowRange(threadId, null));
      signal?.throwIfAborted();
      const requests = keys.map((key) => {
        return tx.store.delete(key);
      });
      await Promise.all([...requests, tx.done]);
      L.debug("clearThread:done", { threadId, count: keys.length });
    },
  };
}

function createIdbEventRowStores(getChatIdb: GetDb) {
  const dbName = "current chat IndexedDB";
  const storeName = CHAT_EVENT_ROWS_STORE;

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
    readStore: createRowReadStore(storeName, getDb),
    writeStore: createRowWriteStore(storeName, getDb),
  });
}

export { createIdbEventRowStores };
