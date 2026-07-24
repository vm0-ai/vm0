import type { IDBPDatabase } from "idb";
import {
  pagedChatMessageSchema,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { logger } from "../log.ts";
import {
  CHAT_MESSAGES_ORDER_INDEX,
  CHAT_MESSAGES_STORE,
} from "./chat-idb-schema.ts";
import {
  disabledChatIdbError,
  logChatIdbDisabled,
  withChatIdbTimeout,
} from "./chat-idb-safe.ts";

const L = logger("ChatMessageIndexedDb");

type StoredPagedChatMessage = PagedChatMessage & {
  readonly threadId: string;
};

interface ChatMessageReadStore {
  readBounds(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ChatMessageBounds>;
  readLatest(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<PagedChatMessage[]>;
}

export interface ChatMessageBounds {
  readonly first: PagedChatMessage | null;
  readonly last: PagedChatMessage | null;
}

interface ChatMessageWriteStore {
  upsertMessages(
    threadId: string,
    messages: PagedChatMessage[],
    signal?: AbortSignal,
  ): Promise<void>;
}

function toApiMessage(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const row = raw as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "threadId") {
      continue;
    }
    if (key === "status" && row.role === "user") {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function validateMessage(raw: unknown): PagedChatMessage {
  return pagedChatMessageSchema.parse(toApiMessage(raw));
}

function storedMessage(
  threadId: string,
  message: PagedChatMessage,
): StoredPagedChatMessage {
  return {
    ...message,
    threadId,
  };
}

function threadOrderRange(threadId: string): IDBKeyRange {
  return IDBKeyRange.bound([threadId], [threadId, []]);
}

type GetDb = () => Promise<IDBPDatabase>;

function createMessageReadStore(
  storeName: string,
  getDb: GetDb,
): ChatMessageReadStore {
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
        first: firstCursor ? validateMessage(firstCursor.value) : null,
        last: lastCursor ? validateMessage(lastCursor.value) : null,
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
      const storedMessages = await index.getAll(range);
      signal?.throwIfAborted();
      const messages = storedMessages.map(validateMessage);
      L.debug("readLatest:done", { threadId, count: messages.length });
      return messages;
    },
  };
}

function createMessageWriteStore(
  storeName: string,
  getDb: GetDb,
): ChatMessageWriteStore {
  return {
    async upsertMessages(threadId, messages, signal) {
      L.debug("upsertMessages:start", {
        threadId,
        count: messages.length,
      });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readwrite");
      const requests = messages.map((message) => {
        signal?.throwIfAborted();
        // Stitch the owning thread onto the server-sequenced cached value.
        return tx.store.put(storedMessage(threadId, message));
      });
      await Promise.all([...requests, tx.done]);
      L.debug("upsertMessages:done", {
        threadId,
        count: messages.length,
      });
    },
  };
}

function createIdbMessageStores(getChatIdb: GetDb) {
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

    // IDB open is a cache fast path; timeout/rejection disables it for this tab.
    // eslint-disable-next-line no-restricted-syntax
    try {
      return await withChatIdbTimeout("messages:openDB", () => {
        return getChatIdb();
      });
    } catch (error) {
      disableForSession(error);
      throw error;
    }
  }

  return Object.freeze({
    readStore: createMessageReadStore(storeName, getDb),
    writeStore: createMessageWriteStore(storeName, getDb),
  });
}

export { createIdbMessageStores };
