import { openDB, type IDBPDatabase } from "idb";
import {
  pagedChatMessageSchema,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { logger } from "../log.ts";
import {
  CHAT_MESSAGES_ORDER_INDEX,
  CHAT_IDB_VERSION,
  CHAT_MESSAGES_STORE,
  upgradeChatIdb,
} from "./chat-idb-schema.ts";

const L = logger("ChatIdbCache");

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
  readBefore(
    threadId: string,
    beforeId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PagedChatMessage[]>;
  messageExists(
    threadId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
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
    orderSequence: message.sequenceNumber ?? -1,
  };
}

function threadOrderRange(threadId: string): IDBKeyRange {
  return IDBKeyRange.bound([threadId], [threadId, []]);
}

function createIdbMessageStores(userId: string, orgId: string) {
  const dbName = `vm0-chat-${userId}-${orgId}`;
  const storeName = CHAT_MESSAGES_STORE;

  let dbPromise: Promise<IDBPDatabase> | null = null;

  function getDb(): Promise<IDBPDatabase> {
    if (!dbPromise) {
      L.debug("openDB", { dbName, storeName });
      // Schema is shared with idb-thread-meta-store.ts: both modules open
      // the same DB at the same version. The upgrade callback creates every store
      // the schema currently defines, idempotently, so whichever module
      // triggers the version bump leaves a complete schema for the other.
      dbPromise = openDB(dbName, CHAT_IDB_VERSION, {
        upgrade(db, oldVersion, _newVersion, tx) {
          L.debug("openDB:upgrade", { dbName, storeName });
          upgradeChatIdb(db, oldVersion, tx);
        },
      });
    }
    return dbPromise;
  }

  const readStore: ChatMessageReadStore = {
    async readLatest(threadId, limit, signal) {
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

    async messageExists(threadId, messageId, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readonly");
      const msg = await tx.store.get(messageId);
      return (
        msg !== undefined &&
        (msg as { threadId?: string }).threadId === threadId
      );
    },

    async readBefore(threadId, beforeId, limit, signal) {
      L.debug("readBefore:start", { threadId, beforeId, limit });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readonly");
      const anchor = await tx.store.get(beforeId);
      if (!anchor) {
        L.debug("readBefore:anchorMiss", { threadId, beforeId });
        return [];
      }
      if ((anchor as { threadId?: string }).threadId !== threadId) {
        L.debug("readBefore:anchorThreadMismatch", { threadId, beforeId });
        return [];
      }
      const anchorMsg = validateMessage(anchor);
      signal?.throwIfAborted();

      const index = tx.store.index(CHAT_MESSAGES_ORDER_INDEX);
      const range = IDBKeyRange.bound(
        [threadId],
        [
          threadId,
          anchorMsg.createdAt,
          anchorMsg.sequenceNumber ?? -1,
          beforeId,
        ],
      );
      const messages: PagedChatMessage[] = [];
      let cursor = await index.openCursor(range, "prev");
      if (cursor?.primaryKey === beforeId) {
        cursor = await cursor.continue();
      }
      while (cursor && messages.length < limit) {
        signal?.throwIfAborted();
        messages.push(validateMessage(cursor.value));
        cursor = await cursor.continue();
      }
      L.debug("readBefore:done", {
        threadId,
        beforeId,
        count: messages.length,
      });
      return messages.reverse();
    },
  };

  const writeStore: ChatMessageWriteStore = {
    async upsertMessages(threadId, messages, signal) {
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
  };

  return Object.freeze({
    readStore,
    writeStore,
  });
}

export { createIdbMessageStores };
