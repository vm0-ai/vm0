import type { IDBPDatabase } from "idb";
import {
  pagedChatMessageSchema,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessageOrderSequence } from "../chat-message-order.ts";
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
  readonly orderSequence: number;
};

interface ChatMessageReadStore {
  readBounds(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ChatMessageBounds>;
  readFrom(
    threadId: string,
    message: PagedChatMessage,
    signal?: AbortSignal,
  ): Promise<PagedChatMessage[]>;
  readLatest(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<PagedChatMessage[]>;
  hasMessage(
    threadId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
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
    if (key === "orderSequence") {
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
    orderSequence: chatMessageOrderSequence(message),
  };
}

function threadOrderRange(threadId: string): IDBKeyRange {
  return IDBKeyRange.bound([threadId], [threadId, []]);
}

function threadOrderRangeFrom(
  threadId: string,
  message: PagedChatMessage,
): IDBKeyRange {
  // PostgreSQL timestamps may carry more precision than the API's ISO string.
  // Re-read the entire visible millisecond so precision loss can only produce
  // duplicates, which are removed by message ID, rather than skipped messages.
  return IDBKeyRange.bound([threadId, message.createdAt], [threadId, []]);
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
    async readFrom(threadId, message, signal) {
      L.debug("readFrom:start", { threadId, messageId: message.id });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readonly");
      const index = tx.store.index(CHAT_MESSAGES_ORDER_INDEX);
      const range = threadOrderRangeFrom(threadId, message);
      const storedMessages = await index.getAll(range);
      signal?.throwIfAborted();
      const messages = storedMessages.map(validateMessage);
      L.debug("readFrom:done", {
        threadId,
        messageId: message.id,
        count: messages.length,
      });
      return messages;
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
    async hasMessage(threadId, messageId, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      const stored: unknown = await db.get(storeName, messageId);
      signal?.throwIfAborted();
      const found =
        stored !== null &&
        typeof stored === "object" &&
        "threadId" in stored &&
        stored.threadId === threadId;
      L.debug("hasMessage:done", { threadId, messageId, found });
      return found;
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
        // Stitch local ordering fields onto the stored value. PagedChatMessage
        // from the API has no threadId and keeps sequenceNumber optional.
        return tx.store.put(storedMessage(threadId, message));
      });
      await Promise.all([...requests, tx.done]);
      L.debug("upsertMessages:done", { threadId, count: messages.length });
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
