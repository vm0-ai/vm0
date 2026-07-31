import type { IDBPDatabase } from "idb";
import {
  type ChatEvent,
  chatEventSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import { logger } from "../log.ts";
import {
  CHAT_MESSAGES_ORDER_INDEX,
  CHAT_MESSAGES_STORE,
} from "./chat-idb-schema.ts";
import { disabledChatIdbError, logChatIdbDisabled } from "./chat-idb-safe.ts";

const L = logger("ChatEventIndexedDb");

type StoredChatEvent = ChatEvent;

interface ChatEventReadStore {
  readBounds(threadId: string, signal?: AbortSignal): Promise<ChatEventBounds>;
  readLatest(threadId: string, signal?: AbortSignal): Promise<ChatEvent[]>;
}

export interface ChatEventBounds {
  readonly first: ChatEvent | null;
  readonly last: ChatEvent | null;
}

interface ChatEventWriteStore {
  upsertEvents(
    threadId: string,
    events: ChatEvent[],
    signal?: AbortSignal,
  ): Promise<void>;
}

function storedChatEvent(raw: unknown): ChatEvent {
  return chatEventSchema.parse(raw);
}

function storedEvent(threadId: string, event: ChatEvent): StoredChatEvent {
  return {
    ...event,
    threadId,
  };
}

function threadOrderRange(threadId: string): IDBKeyRange {
  return IDBKeyRange.bound([threadId], [threadId, []]);
}

type GetDb = () => Promise<IDBPDatabase>;

function createEventReadStore(
  storeName: string,
  getDb: GetDb,
): ChatEventReadStore {
  return {
    async readBounds(threadId, signal) {
      L.debug("readBounds:start", { threadId });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readonly");
      const index = tx.store.index(CHAT_MESSAGES_ORDER_INDEX);
      const range = threadOrderRange(threadId);
      const readBound = async (
        direction: IDBCursorDirection,
      ): Promise<ChatEvent | null> => {
        const cursor = await index.openCursor(range, direction);
        return cursor ? storedChatEvent(cursor.value) : null;
      };
      const [first, last] = await Promise.all([
        readBound("next"),
        readBound("prev"),
      ]);
      signal?.throwIfAborted();
      const bounds = { first, last };
      L.debug("readBounds:done", {
        threadId,
        firstId: bounds.first?.id ?? null,
        lastId: bounds.last?.id ?? null,
      });
      return bounds;
    },
    async readLatest(threadId, signal) {
      L.debug("readLatest:start", { threadId });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readonly");
      const index = tx.store.index(CHAT_MESSAGES_ORDER_INDEX);
      const range = threadOrderRange(threadId);
      const storedEvents = await index.getAll(range);
      signal?.throwIfAborted();
      const events = storedEvents.map(storedChatEvent);
      L.debug("readLatest:done", { threadId, count: events.length });
      return events;
    },
  };
}

function createEventWriteStore(
  storeName: string,
  getDb: GetDb,
): ChatEventWriteStore {
  return {
    async upsertEvents(threadId, events, signal) {
      L.debug("upsertEvents:start", {
        threadId,
        count: events.length,
      });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readwrite");
      const requests = events.map((event) => {
        signal?.throwIfAborted();
        // Stitch the local order key onto the canonical ChatEvent.
        return tx.store.put(storedEvent(threadId, event));
      });
      await Promise.all([...requests, tx.done]);
      L.debug("upsertEvents:done", { threadId, count: events.length });
    },
  };
}

function createIdbEventStores(getChatIdb: GetDb) {
  const dbName = "current chat IndexedDB";
  const storeName = CHAT_MESSAGES_STORE;

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
    // eslint-disable-next-line no-restricted-syntax
    try {
      return await getChatIdb();
    } catch (error) {
      disableForSession(error);
      throw error;
    }
  }

  return Object.freeze({
    readStore: createEventReadStore(storeName, getDb),
    writeStore: createEventWriteStore(storeName, getDb),
  });
}

export { createIdbEventStores };
