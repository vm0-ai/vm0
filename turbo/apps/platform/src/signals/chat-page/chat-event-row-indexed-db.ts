import { command, computed } from "ccstate";
import type { ChatEventRowV4 } from "@okouai/api-contracts/contracts/chat-event-rows";
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
    const rows = await chatIdbReadOr<ChatEventRowV4[]>(
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

export const loadIndexedDbChatEventRowLastSeqId$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const stores = await get(chatEventRowStores$);
    signal.throwIfAborted();
    const lastSeqId = await chatIdbReadOr<number | null>(
      "indexedDbEventRows:readLastSeqId",
      () => {
        return stores.readStore.readLastSeqId(threadId, signal);
      },
      null,
      signal,
    );
    signal.throwIfAborted();
    return lastSeqId;
  },
);

export const writeIndexedDbChatEventRows$ = command(
  async (
    { get },
    rows: readonly ChatEventRowV4[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (rows.length === 0) {
      return;
    }
    const stores = await get(chatEventRowStores$);
    signal.throwIfAborted();
    await chatIdbWriteBestEffort(
      "indexedDbEventRows:upsert",
      () => {
        return stores.writeStore.upsertRows(rows, signal);
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
