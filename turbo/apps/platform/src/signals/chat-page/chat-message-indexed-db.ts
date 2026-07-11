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
import { setLoop } from "../utils.ts";

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

export const loadIndexedDbChatMessagesBefore$ = command(
  async ({ get }, threadId: string, beforeId: string, signal: AbortSignal) => {
    const stores = await get(chatMessageStores$);
    signal.throwIfAborted();
    let cursorId = beforeId;
    const messagePages: PagedChatMessage[][] = [];
    const seenIds = new Set<string>([beforeId]);
    await setLoop(
      async (loopSignal) => {
        const page = await chatIdbReadOr(
          "indexedDbMessages:readBefore",
          () => {
            return stores.readStore.readBefore(
              threadId,
              cursorId,
              MESSAGE_PAGE_SIZE,
              loopSignal,
            );
          },
          [],
          loopSignal,
        );
        loopSignal.throwIfAborted();
        const newMessages = page.filter((message) => {
          return !seenIds.has(message.id);
        });
        if (newMessages.length === 0) {
          return true;
        }
        for (const message of newMessages) {
          seenIds.add(message.id);
        }
        messagePages.unshift(newMessages);
        if (page.length < MESSAGE_PAGE_SIZE) {
          return true;
        }
        cursorId = newMessages[0]!.id;
        return false;
      },
      0,
      signal,
    );
    const messages = messagePages.flat();
    L.debug("loadIndexedDbMessagesBefore", {
      threadId,
      beforeId,
      count: messages.length,
      pages: messagePages.length,
    });
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
  ): Promise<{ messages: PagedChatMessage[]; reachedEnd: boolean } | null> => {
    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { sinceId, limit: MESSAGE_PAGE_SIZE },
        fetchOptions: { signal },
      }),
      [200, 404],
    );
    signal.throwIfAborted();
    if (result.status === 404) {
      return null;
    }
    return {
      messages: result.body.messages,
      reachedEnd: result.body.messages.length < MESSAGE_PAGE_SIZE,
    };
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
    await setLoop(
      async (loopSignal) => {
        const result = await set(
          warmListMessagesAfter$,
          threadId,
          sinceId,
          loopSignal,
        );
        loopSignal.throwIfAborted();
        if (result === null) {
          return true;
        }

        if (result.messages.length > 0) {
          await chatIdbWriteBestEffort(
            "indexedDbMessages:warmUpsert",
            () => {
              return stores.writeStore.upsertMessages(
                threadId,
                result.messages,
                loopSignal,
              );
            },
            loopSignal,
          );
          loopSignal.throwIfAborted();
          const nextSinceId = result.messages.at(-1)!.id;
          if (nextSinceId === sinceId) {
            return true;
          }
          sinceId = nextSinceId;
        }

        return result.reachedEnd;
      },
      0,
      signal,
    );
  },
);
