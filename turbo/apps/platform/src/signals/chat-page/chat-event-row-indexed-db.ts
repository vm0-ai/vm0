import { command, computed } from "ccstate";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatIdbReadOr,
  chatIdbWriteBestEffort,
} from "../external/chat-idb-safe.ts";
import { createIdbEventRowStores } from "../external/idb-event-row-store.ts";
import { chatIdb$ } from "../external/chat-idb-store.ts";
import { logger } from "../log.ts";

const L = logger("ChatEventRowIndexedDb");

type Stores = ReturnType<typeof createIdbEventRowStores>;

const chatEventRowStores$ = computed((get): Stores => {
  const dbPromise = get(chatIdb$);
  return createIdbEventRowStores(() => {
    return dbPromise;
  });
});

export const loadIndexedDbChatEventRowsAfter$ = command(
  async (
    { get },
    threadId: string,
    afterSeqId: number | null,
    signal: AbortSignal,
  ) => {
    const stores = await get(chatEventRowStores$);
    signal.throwIfAborted();
    const rows = await chatIdbReadOr<ChatEventRow[]>(
      "indexedDbEventRows:readRowsAfter",
      () => {
        return stores.readStore.readRowsAfter(threadId, afterSeqId, signal);
      },
      [],
      signal,
    );
    signal.throwIfAborted();
    L.debug("loadIndexedDbChatEventRowsAfter", {
      threadId,
      afterSeqId,
      count: rows.length,
    });
    return rows;
  },
);

export const loadIndexedDbChatEventCursor$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const stores = await get(chatEventRowStores$);
    signal.throwIfAborted();
    const cursor = await chatIdbReadOr<ChatEventCursor | null>(
      "indexedDbEventRows:readCursor",
      () => {
        return stores.readStore.readCursor(threadId, signal);
      },
      null,
      signal,
    );
    signal.throwIfAborted();
    return cursor;
  },
);

export const writeIndexedDbChatEventRows$ = command(
  async (
    { get },
    {
      threadId,
      rows,
      cursor,
    }: {
      readonly threadId: string;
      readonly rows: readonly ChatEventRow[];
      readonly cursor: ChatEventCursor;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const stores = await get(chatEventRowStores$);
    signal.throwIfAborted();
    await chatIdbWriteBestEffort(
      "indexedDbEventRows:upsert",
      () => {
        return stores.writeStore.upsertRowsAndCursor(
          threadId,
          rows,
          cursor,
          signal,
        );
      },
      signal,
    );
  },
);

export const replaceIndexedDbChatEventRows$ = command(
  async (
    { get },
    {
      threadId,
      rows,
      cursor,
    }: {
      readonly threadId: string;
      readonly rows: readonly ChatEventRow[];
      readonly cursor: ChatEventCursor;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const stores = await get(chatEventRowStores$);
    signal.throwIfAborted();
    await chatIdbWriteBestEffort(
      "indexedDbEventRows:replace",
      () => {
        return stores.writeStore.replaceRowsAndCursor(
          threadId,
          rows,
          cursor,
          signal,
        );
      },
      signal,
    );
  },
);

export const clearIndexedDbChatEventRows$ = command(
  async ({ get }, threadId: string, signal: AbortSignal): Promise<void> => {
    const stores = await get(chatEventRowStores$);
    signal.throwIfAborted();
    await chatIdbWriteBestEffort(
      "indexedDbEventRows:clearThread",
      () => {
        return stores.writeStore.clearThread(threadId, signal);
      },
      signal,
    );
  },
);
