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
  chatIdbReadOr,
  chatIdbWriteBestEffort,
  disabledChatIdbError,
  logChatIdbDisabled,
  withChatIdbTimeout,
} from "./chat-idb-safe.ts";
import { openChatIdb } from "./chat-idb-store.ts";

const L = logger("ChatMessageIndexedDb");

type StoredPagedChatMessage = PagedChatMessage & {
  readonly threadId: string;
  readonly orderSequence: number;
};

interface ChatMessageReadStore {
  readLatest(
    threadId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<PagedChatMessage[]>;
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

type GetDb = () => Promise<IDBPDatabase>;

function createMessageReadStore(
  storeName: string,
  getDb: GetDb,
): ChatMessageReadStore {
  return {
    async readLatest(threadId, limit, signal) {
      return await chatIdbReadOr(
        "messages:readLatest",
        async () => {
          L.debug("readLatest:start", { threadId, limit });
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(storeName, "readonly");
          const index = tx.store.index(CHAT_MESSAGES_ORDER_INDEX);
          const range = threadOrderRange(threadId);
          const messages: PagedChatMessage[] = [];
          let cursor = await index.openCursor(range, "prev");
          while (cursor && (limit === undefined || messages.length < limit)) {
            signal?.throwIfAborted();
            messages.push(validateMessage(cursor.value));
            cursor = await cursor.continue();
          }
          L.debug("readLatest:done", { threadId, count: messages.length });
          return messages.reverse();
        },
        [],
        signal,
      );
    },
  };
}

function createMessageWriteStore(
  storeName: string,
  getDb: GetDb,
): ChatMessageWriteStore {
  return {
    async upsertMessages(threadId, messages, signal) {
      await chatIdbWriteBestEffort(
        "messages:upsertMessages",
        async () => {
          L.debug("upsertMessages:start", {
            threadId,
            count: messages.length,
          });
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(storeName, "readwrite");
          for (const msg of messages) {
            signal?.throwIfAborted();
            // Stitch local ordering fields onto the stored value. PagedChatMessage
            // from the API has no threadId and keeps sequenceNumber optional.
            await tx.store.put(storedMessage(threadId, msg));
          }
          await tx.done;
          L.debug("upsertMessages:done", { threadId, count: messages.length });
        },
        signal,
      );
    },
  };
}

function createIdbMessageStores(userId: string, orgId: string) {
  const dbName = `vm0-chat-${userId}-${orgId}`;
  const storeName = CHAT_MESSAGES_STORE;

  let dbPromise: Promise<IDBPDatabase> | null = null;
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

    if (!dbPromise) {
      L.debug("openDB", { dbName, storeName });
      const openPromise = openChatIdb(userId, orgId);
      dbPromise = openPromise;
    }

    const pending = dbPromise;
    // IDB open is a cache fast path; timeout/rejection disables it for this tab.
    // eslint-disable-next-line no-restricted-syntax
    try {
      return await withChatIdbTimeout("messages:openDB", () => {
        return pending;
      });
    } catch (error) {
      if (dbPromise === pending) {
        dbPromise = null;
      }
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
