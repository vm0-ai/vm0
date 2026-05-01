import { openDB, type IDBPDatabase } from "idb";
import {
  pagedChatMessageSchema,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { logger } from "../log.ts";

const L = logger("ChatIdbCache");

interface ChatMessageReadStore {
  readLatest(
    threadId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PagedChatMessage[]>;
  readBefore(
    threadId: string,
    beforeId: string,
    limit: number,
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

function createIdbMessageStores(userId: string, orgId: string) {
  const dbName = `vm0-chat-${userId}-${orgId}`;
  const storeName = "chat_messages";

  let dbPromise: Promise<IDBPDatabase> | null = null;

  function getDb(): Promise<IDBPDatabase> {
    if (!dbPromise) {
      L.debug("openDB", { dbName, storeName });
      dbPromise = openDB(dbName, 1, {
        upgrade(db) {
          L.debug("openDB:upgrade", { dbName, storeName });
          const store = db.createObjectStore(storeName, { keyPath: "id" });
          store.createIndex("byThreadAndTime", ["threadId", "createdAt"]);
        },
      });
    }
    return dbPromise;
  }

  function validateMessage(raw: unknown): PagedChatMessage {
    return pagedChatMessageSchema.parse(raw);
  }

  const readStore: ChatMessageReadStore = {
    async readLatest(threadId, limit, signal) {
      L.debug("readLatest:start", { threadId, limit });
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(storeName, "readonly");
      const index = tx.store.index("byThreadAndTime");
      const range = IDBKeyRange.bound([threadId, ""], [threadId, "￿"]);
      const messages: PagedChatMessage[] = [];
      let cursor = await index.openCursor(range, "prev");
      while (cursor && messages.length < limit) {
        signal?.throwIfAborted();
        messages.push(validateMessage(cursor.value));
        cursor = await cursor.continue();
      }
      L.debug("readLatest:done", { threadId, count: messages.length });
      return messages.reverse();
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
      const anchorMsg = validateMessage(anchor);
      signal?.throwIfAborted();

      const index = tx.store.index("byThreadAndTime");
      const range = IDBKeyRange.bound(
        [threadId, ""],
        [threadId, anchorMsg.createdAt],
      );
      const messages: PagedChatMessage[] = [];
      let cursor = await index.openCursor(range, "prev");
      // Skip the anchor and any rows with the same createdAt that sort after it
      while (cursor) {
        const msg = validateMessage(cursor.value);
        if (msg.createdAt === anchorMsg.createdAt && msg.id >= beforeId) {
          cursor = await cursor.continue();
        } else {
          break;
        }
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
        // Stitch threadId onto the stored value so the byThreadAndTime
        // index can find it. PagedChatMessage from the API has no threadId.
        await tx.store.put({ ...msg, threadId });
      }
      await tx.done;
      L.debug("upsertMessages:done", { threadId, count: messages.length });
    },
  };

  return Object.freeze({
    readStore$: readStore,
    writeStore$: writeStore,
  });
}

export { createIdbMessageStores };
