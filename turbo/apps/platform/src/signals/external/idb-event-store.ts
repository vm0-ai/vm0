import type { IDBPDatabase } from "idb";
import {
  chatEventSchema,
  type ChatEvent,
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

function toCanonicalEvent(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const row = raw as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "role" || key === "revokesMessageId") {
      continue;
    }
    if (key === "status" && row.role === "user") {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function validateEvent(raw: unknown): ChatEvent {
  return chatEventSchema.parse(toCanonicalEvent(raw));
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
      const [firstCursor, lastCursor] = await Promise.all([
        index.openCursor(range, "next"),
        index.openCursor(range, "prev"),
      ]);
      signal?.throwIfAborted();
      const bounds = {
        first: firstCursor ? validateEvent(firstCursor.value) : null,
        last: lastCursor ? validateEvent(lastCursor.value) : null,
      };
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
      const events = storedEvents.map(validateEvent);
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
