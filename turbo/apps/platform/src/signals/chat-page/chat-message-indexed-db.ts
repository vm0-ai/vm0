import { command, computed } from "ccstate";
import {
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import {
  chatIdbReadOr,
  chatIdbWriteBestEffort,
} from "../external/chat-idb-safe.ts";
import { createIdbMessageStores } from "../external/idb-message-store.ts";
import { logger } from "../log.ts";

const L = logger("ChatMessageIndexedDb");
const MESSAGE_PAGE_SIZE = 50;

type Stores = ReturnType<typeof createIdbMessageStores>;

const chatMessageStores$ = computed(async (get): Promise<Stores> => {
  const { userId, orgId } = await get(authenticatedIdentity$);
  return createIdbMessageStores(userId, orgId);
});

export const loadIndexedDbChatMessages$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const stores = await get(chatMessageStores$);
    signal.throwIfAborted();
    const messages = await chatIdbReadOr(
      "indexedDbMessages:readLatest",
      () => {
        return stores.readStore.readLatest(threadId, undefined, signal);
      },
      [],
      signal,
    );
    signal.throwIfAborted();
    L.debug("loadIndexedDbMessages", { threadId, count: messages.length });
    return messages;
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

const warmListMessagesAfter$ = command(
  async (
    { get },
    threadId: string,
    sinceId: string | undefined,
    signal: AbortSignal,
  ): Promise<PagedChatMessage[]> => {
    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { sinceId, limit: MESSAGE_PAGE_SIZE },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body.messages;
  },
);

export const warmLatestChatThreadMessages$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const stores = await get(chatMessageStores$);
    signal.throwIfAborted();
    const latest = await chatIdbReadOr(
      "indexedDbMessages:warmReadLatest",
      () => {
        return stores.readStore.readLatest(threadId, 1, signal);
      },
      [],
      signal,
    );
    signal.throwIfAborted();

    let sinceId = latest[0]?.id;
    while (true) {
      const result = await set(
        warmListMessagesAfter$,
        threadId,
        sinceId,
        signal,
      );
      signal.throwIfAborted();
      if (result.length === 0) {
        return;
      }

      await chatIdbWriteBestEffort(
        "indexedDbMessages:warmUpsert",
        () => {
          return stores.writeStore.upsertMessages(threadId, result, signal);
        },
        signal,
      );
      signal.throwIfAborted();
      sinceId = result.at(-1)!.id;
    }
  },
);
