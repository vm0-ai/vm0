import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "./chat-idb-schema.ts";
import { chatIdbReadOr, chatIdbWriteBestEffort } from "./chat-idb-safe.ts";
import { openChatIdb } from "./chat-idb-store.ts";

const SINGLETON_ID = "current";

export interface ChatThreadSnapshotRecord {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
}

interface StoredChatThreadSnapshot extends ChatThreadSnapshotRecord {
  readonly id: typeof SINGLETON_ID;
}

interface StoredChatThreadEventSync {
  readonly id: typeof SINGLETON_ID;
  readonly latestEventId: string | null;
}

type GetDb = ReturnType<typeof createGetDb>;

function createGetDb(userId: string, orgId: string) {
  return () => {
    return openChatIdb(userId, orgId);
  };
}

function validateSnapshot(raw: unknown): ChatThreadSnapshotRecord | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const row = raw as Partial<StoredChatThreadSnapshot>;
  return {
    chatThreads: chatThreadSnapshotProjectionSchema
      .array()
      .parse(row.chatThreads ?? []),
    latestEventId:
      typeof row.latestEventId === "string" ? row.latestEventId : null,
  };
}

function validateEvent(raw: unknown): ChatThreadEvent {
  return chatThreadEventSchema.parse(raw);
}

function createReadStore(getDb: GetDb) {
  return {
    async readSnapshot(signal?: AbortSignal) {
      return await chatIdbReadOr(
        "threadEvents:readSnapshot",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const raw = await db
            .transaction(CHAT_THREAD_SNAPSHOT_STORE, "readonly")
            .store.get(SINGLETON_ID);
          return validateSnapshot(raw);
        },
        null,
        signal,
      );
    },

    async readEvents(signal?: AbortSignal) {
      return await chatIdbReadOr(
        "threadEvents:readEvents",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(CHAT_THREAD_EVENTS_STORE, "readonly");
          const index = tx.store.index(CHAT_THREAD_EVENTS_ORDER_INDEX);
          const events: ChatThreadEvent[] = [];
          let cursor = await index.openCursor();
          while (cursor) {
            signal?.throwIfAborted();
            events.push(validateEvent(cursor.value));
            cursor = await cursor.continue();
          }
          return events;
        },
        [],
        signal,
      );
    },

    async readLatestEventId(signal?: AbortSignal) {
      return await chatIdbReadOr(
        "threadEvents:readLatestEventId",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const raw = (await db
            .transaction(CHAT_THREAD_EVENT_SYNC_STORE, "readonly")
            .store.get(SINGLETON_ID)) as
            | Partial<StoredChatThreadEventSync>
            | undefined;
          return typeof raw?.latestEventId === "string"
            ? raw.latestEventId
            : null;
        },
        null,
        signal,
      );
    },
  };
}

function createWriteStore(getDb: GetDb) {
  return {
    async replaceFromSnapshot(
      snapshot: ChatThreadSnapshotRecord,
      signal?: AbortSignal,
    ) {
      await chatIdbWriteBestEffort(
        "threadEvents:replaceFromSnapshot",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(
            [
              CHAT_THREAD_SNAPSHOT_STORE,
              CHAT_THREAD_EVENTS_STORE,
              CHAT_THREAD_EVENT_SYNC_STORE,
            ],
            "readwrite",
          );
          await tx.objectStore(CHAT_THREAD_EVENTS_STORE).clear();
          await tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE).put({
            id: SINGLETON_ID,
            chatThreads: [...snapshot.chatThreads],
            latestEventId: snapshot.latestEventId,
          } satisfies StoredChatThreadSnapshot);
          await tx.objectStore(CHAT_THREAD_EVENT_SYNC_STORE).put({
            id: SINGLETON_ID,
            latestEventId: snapshot.latestEventId,
          } satisfies StoredChatThreadEventSync);
          await tx.done;
        },
        signal,
      );
    },

    async upsertEvents(
      events: readonly ChatThreadEvent[],
      signal?: AbortSignal,
    ) {
      if (events.length === 0) {
        return;
      }
      await chatIdbWriteBestEffort(
        "threadEvents:upsertEvents",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(
            [CHAT_THREAD_EVENTS_STORE, CHAT_THREAD_EVENT_SYNC_STORE],
            "readwrite",
          );
          const eventStore = tx.objectStore(CHAT_THREAD_EVENTS_STORE);
          for (const event of events) {
            signal?.throwIfAborted();
            await eventStore.put(event);
          }
          await tx.objectStore(CHAT_THREAD_EVENT_SYNC_STORE).put({
            id: SINGLETON_ID,
            latestEventId: events[events.length - 1]!.id,
          } satisfies StoredChatThreadEventSync);
          await tx.done;
        },
        signal,
      );
    },

    async clear(signal?: AbortSignal) {
      await chatIdbWriteBestEffort(
        "threadEvents:clear",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(
            [
              CHAT_THREAD_SNAPSHOT_STORE,
              CHAT_THREAD_EVENTS_STORE,
              CHAT_THREAD_EVENT_SYNC_STORE,
            ],
            "readwrite",
          );
          await Promise.all([
            tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE).clear(),
            tx.objectStore(CHAT_THREAD_EVENTS_STORE).clear(),
            tx.objectStore(CHAT_THREAD_EVENT_SYNC_STORE).clear(),
          ]);
          await tx.done;
        },
        signal,
      );
    },
  };
}

export function createIdbChatThreadEventStores(userId: string, orgId: string) {
  const getDb = createGetDb(userId, orgId);

  return Object.freeze({
    readStore: createReadStore(getDb),
    writeStore: createWriteStore(getDb),
  });
}
