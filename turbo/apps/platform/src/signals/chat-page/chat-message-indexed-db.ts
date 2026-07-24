import { command, computed } from "ccstate";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatIdbReadOr,
  chatIdbWriteBestEffort,
} from "../external/chat-idb-safe.ts";
import {
  createIdbMessageStores,
  type ChatMessageBounds,
} from "../external/idb-message-store.ts";
import { chatIdb$ } from "../external/chat-idb-store.ts";
import { logger } from "../log.ts";

const L = logger("ChatMessageIndexedDb");

type Stores = ReturnType<typeof createIdbMessageStores>;

const chatMessageStores$ = computed((get): Stores => {
  const dbPromise = get(chatIdb$);
  return createIdbMessageStores(() => {
    return dbPromise;
  });
});

export const loadIndexedDbChatMessages$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const stores = await get(chatMessageStores$);
    signal.throwIfAborted();
    const messages = await chatIdbReadOr(
      "indexedDbMessages:readLatest",
      () => {
        return stores.readStore.readLatest(threadId, signal);
      },
      [],
      signal,
    );
    signal.throwIfAborted();
    L.debug("loadIndexedDbMessages", { threadId, count: messages.length });
    return messages;
  },
);

export const loadIndexedDbChatMessageBounds$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const stores = await get(chatMessageStores$);
    signal.throwIfAborted();
    const bounds = await chatIdbReadOr<ChatMessageBounds>(
      "indexedDbMessages:readBounds",
      () => {
        return stores.readStore.readBounds(threadId, signal);
      },
      { first: null, last: null },
      signal,
    );
    signal.throwIfAborted();
    L.debug("loadIndexedDbMessageBounds", {
      threadId,
      firstId: bounds.first?.id ?? null,
      lastId: bounds.last?.id ?? null,
    });
    return bounds;
  },
);

export const writeIndexedDbChatMessages$ = command(
  async (
    { get },
    threadId: string,
    messages: PagedChatMessage[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (messages.length === 0) {
      return;
    }
    const stores = await get(chatMessageStores$);
    signal.throwIfAborted();
    await chatIdbWriteBestEffort(
      "indexedDbMessages:upsert",
      () => {
        return stores.writeStore.upsertMessages(threadId, messages, signal);
      },
      signal,
    );
  },
);
