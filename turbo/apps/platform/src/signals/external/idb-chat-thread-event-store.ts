import type { IDBPDatabase } from "idb";
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

const SINGLETON_ID = "current";
const EVENT_READ_PAGE_SIZE = 300;

type ChatThreadEventOrderKey = [createdAt: string, id: string];

interface ChatThreadSnapshotRecord {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
}

interface ChatThreadEventLog {
  readonly events: readonly ChatThreadEvent[];
  readonly latestEventId: string | null;
}

interface ChatThreadEventReadBoundary {
  readonly latestEventId: string;
  readonly latestEventOrderKey: ChatThreadEventOrderKey;
}

interface StoredChatThreadSnapshot extends ChatThreadSnapshotRecord {
  readonly id: typeof SINGLETON_ID;
}

type GetDb = () => Promise<IDBPDatabase>;

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

function validateLatestEventId(raw: unknown): string | null {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new Error("Invalid IndexedDB chat thread event primary key");
  }
  return raw;
}

function validateEventOrderKey(raw: unknown): ChatThreadEventOrderKey {
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    typeof raw[0] !== "string" ||
    typeof raw[1] !== "string"
  ) {
    throw new Error("Invalid IndexedDB chat thread event order key");
  }
  return [raw[0], raw[1]];
}

function emptyEventLog(): ChatThreadEventLog {
  return { events: [], latestEventId: null };
}

async function readEventBoundary(
  getDb: GetDb,
  signal?: AbortSignal,
): Promise<ChatThreadEventReadBoundary | null> {
  return await chatIdbReadOr(
    "threadEvents:readBoundary",
    async () => {
      const db = await getDb();
      signal?.throwIfAborted();
      const latestCursor = await db
        .transaction(CHAT_THREAD_EVENTS_STORE, "readonly")
        .store.index(CHAT_THREAD_EVENTS_ORDER_INDEX)
        .openKeyCursor(undefined, "prev");
      signal?.throwIfAborted();
      if (!latestCursor) {
        return null;
      }
      const latestEventId = validateLatestEventId(latestCursor.primaryKey);
      const latestEventOrderKey = validateEventOrderKey(latestCursor.key);
      if (latestEventOrderKey[1] !== latestEventId) {
        throw new Error("IndexedDB chat thread event boundary is inconsistent");
      }
      return {
        latestEventId,
        latestEventOrderKey,
      };
    },
    null,
    signal,
  );
}

async function readEventPage(
  getDb: GetDb,
  after: ChatThreadEventOrderKey | null,
  through: ChatThreadEventOrderKey,
  signal?: AbortSignal,
): Promise<readonly ChatThreadEvent[] | null> {
  return await chatIdbReadOr(
    "threadEvents:readPage",
    async () => {
      const db = await getDb();
      signal?.throwIfAborted();
      const tx = db.transaction(CHAT_THREAD_EVENTS_STORE, "readonly");
      const index = tx.store.index(CHAT_THREAD_EVENTS_ORDER_INDEX);
      const range = after
        ? IDBKeyRange.bound(after, through, true)
        : IDBKeyRange.upperBound(through);
      const storedEvents = await index.getAll(range, EVENT_READ_PAGE_SIZE);
      signal?.throwIfAborted();
      return storedEvents.map(validateEvent);
    },
    null,
    signal,
  );
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

    async readEventLog(signal?: AbortSignal) {
      const boundary = await readEventBoundary(getDb, signal);
      if (!boundary) {
        return emptyEventLog();
      }

      const events: ChatThreadEvent[] = [];
      let after: ChatThreadEventOrderKey | null = null;
      while (events.at(-1)?.id !== boundary.latestEventId) {
        const page = await readEventPage(
          getDb,
          after,
          boundary.latestEventOrderKey,
          signal,
        );
        if (!page) {
          return emptyEventLog();
        }
        const lastEvent = page.at(-1);
        if (!lastEvent) {
          return emptyEventLog();
        }
        events.push(...page);
        after = [lastEvent.createdAt, lastEvent.id];
      }

      return {
        events,
        latestEventId: boundary.latestEventId,
      } satisfies ChatThreadEventLog;
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
            [CHAT_THREAD_SNAPSHOT_STORE, CHAT_THREAD_EVENTS_STORE],
            "readwrite",
          );
          await tx.objectStore(CHAT_THREAD_EVENTS_STORE).clear();
          await tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE).put({
            id: SINGLETON_ID,
            chatThreads: [...snapshot.chatThreads],
            latestEventId: snapshot.latestEventId,
          } satisfies StoredChatThreadSnapshot);
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
          const tx = db.transaction(CHAT_THREAD_EVENTS_STORE, "readwrite");
          const eventStore = tx.store;
          const requests = events.map((event) => {
            signal?.throwIfAborted();
            return eventStore.put(event);
          });
          await Promise.all([...requests, tx.done]);
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

export function createIdbChatThreadEventStores(getDb: GetDb) {
  return Object.freeze({
    readStore: createReadStore(getDb),
    writeStore: createWriteStore(getDb),
  });
}
