import { command, computed } from "ccstate";
import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatIdbReadOr,
  chatIdbWriteBestEffort,
} from "../external/chat-idb-safe.ts";
import {
  createIdbEventStores,
  type ChatEventBounds,
} from "../external/idb-event-store.ts";
import { chatIdb$ } from "../external/chat-idb-store.ts";
import { logger } from "../log.ts";

const L = logger("ChatEventIndexedDb");

type Stores = ReturnType<typeof createIdbEventStores>;

const chatEventStores$ = computed((get): Stores => {
  const dbPromise = get(chatIdb$);
  return createIdbEventStores(() => {
    return dbPromise;
  });
});

export const loadIndexedDbChatEvents$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const stores = await get(chatEventStores$);
    signal.throwIfAborted();
    const events = await chatIdbReadOr(
      "indexedDbMessages:readLatest",
      () => {
        return stores.readStore.readLatest(threadId, signal);
      },
      [],
      signal,
    );
    signal.throwIfAborted();
    L.debug("loadIndexedDbEvents", { threadId, count: events.length });
    return events;
  },
);

export const loadIndexedDbChatEventBounds$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const stores = await get(chatEventStores$);
    signal.throwIfAborted();
    const bounds = await chatIdbReadOr<ChatEventBounds>(
      "indexedDbMessages:readBounds",
      () => {
        return stores.readStore.readBounds(threadId, signal);
      },
      { first: null, last: null },
      signal,
    );
    signal.throwIfAborted();
    L.debug("loadIndexedDbEventBounds", {
      threadId,
      firstId: bounds.first?.id ?? null,
      lastId: bounds.last?.id ?? null,
    });
    return bounds;
  },
);

export const writeIndexedDbChatEvents$ = command(
  async (
    { get },
    threadId: string,
    events: ChatEvent[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (events.length === 0) {
      return;
    }
    const stores = await get(chatEventStores$);
    signal.throwIfAborted();
    await chatIdbWriteBestEffort(
      "indexedDbMessages:upsert",
      () => {
        return stores.writeStore.upsertEvents(threadId, events, signal);
      },
      signal,
    );
  },
);
