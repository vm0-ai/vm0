import { command, computed } from "ccstate";
import {
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { clerk$ } from "../auth.ts";
import {
  chatIdbReadOr,
  chatIdbWriteBestEffort,
} from "../external/chat-idb-safe.ts";
import { createIdbMessageStores } from "../external/idb-message-store.ts";
import {
  patchThreadMeta$,
  readThreadMeta$,
} from "../external/idb-thread-meta-store.ts";
import { logger } from "../log.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import type {
  ChatThreadDataSource,
  GetMessageArgs,
  InitialPage,
  ListMessagesAfterArgs,
  ListMessagesBeforeArgs,
  SubscribeRealtimeArgs,
} from "./chat-thread-data-source.ts";

const L = logger("ChatIdbCache");
const MESSAGE_PAGE_SIZE = 50;

type Stores = ReturnType<typeof createIdbMessageStores>;
type ListMessagesAfterResult = {
  messages: PagedChatMessage[];
  reachedEnd: boolean;
};

const warmListMessagesAfter$ = command(
  async (
    { get },
    { threadId, sinceId }: ListMessagesAfterArgs,
    signal: AbortSignal,
  ): Promise<ListMessagesAfterResult | null> => {
    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { sinceId, limit: 50 },
        fetchOptions: { signal },
      }),
      [200, 404],
      { toast: false },
    );
    signal.throwIfAborted();
    if (result.status === 404) {
      L.debug("warmLatest:notFound", { threadId, sinceId });
      return null;
    }
    return {
      messages: result.body.messages,
      reachedEnd: result.body.messages.length < 50,
    };
  },
);

interface CachedMessageReadStore {
  readBefore(
    threadId: string,
    beforeId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PagedChatMessage[]>;
}

function reachedStart(
  cached: PagedChatMessage[],
  startMessageId: string | null,
): boolean {
  if (!startMessageId) {
    return false;
  }
  return cached.some((m) => {
    return m.id === startMessageId;
  });
}

export async function readCachedMessagesBeforeUntilMiss(
  readStore: CachedMessageReadStore,
  threadId: string,
  beforeId: string,
  startMessageId: string | null,
  signal: AbortSignal,
): Promise<{ messages: PagedChatMessage[]; hasMore: boolean; pages: number }> {
  let cursorId = beforeId;
  const messagePages: PagedChatMessage[][] = [];
  const seenIds = new Set<string>([beforeId]);

  while (true) {
    const page = await chatIdbReadOr(
      "cachedDataSource:readBefore",
      () => {
        return readStore.readBefore(
          threadId,
          cursorId,
          MESSAGE_PAGE_SIZE,
          signal,
        );
      },
      [],
      signal,
    );
    signal.throwIfAborted();

    const newMessages = page.filter((message) => {
      return !seenIds.has(message.id);
    });
    if (newMessages.length === 0) {
      break;
    }

    for (const message of newMessages) {
      seenIds.add(message.id);
    }
    messagePages.unshift(newMessages);

    if (
      reachedStart(newMessages, startMessageId) ||
      page.length < MESSAGE_PAGE_SIZE
    ) {
      break;
    }

    cursorId = newMessages[0]!.id;
  }

  const messages = messagePages.flat();
  return {
    messages,
    hasMore: !reachedStart(messages, startMessageId),
    pages: messagePages.length,
  };
}

function createListMessagesBefore(
  remote: ChatThreadDataSource,
  getStores: (userId: string, orgId: string) => Stores,
) {
  return command(
    async (
      { get, set },
      { threadId: tid, beforeId }: ListMessagesBeforeArgs,
      signal: AbortSignal,
    ) => {
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const userId = clerk.user?.id;
      const orgId = clerk.organization?.id;

      if (!userId || !orgId) {
        L.debug("listBefore:noAuth", { threadId: tid, beforeId });
        return set(
          remote.listMessagesBefore$,
          { threadId: tid, beforeId },
          signal,
        );
      }

      const stores = getStores(userId, orgId);
      const readStore = stores.readStore;
      const meta = await chatIdbReadOr(
        "cachedDataSource:readThreadMetaBefore",
        () => {
          return readThreadMeta$(userId, orgId, tid, signal);
        },
        null,
        signal,
      );
      const cached = await readCachedMessagesBeforeUntilMiss(
        readStore,
        tid,
        beforeId,
        meta?.startMessageId ?? null,
        signal,
      );

      if (cached.messages.length > 0) {
        L.debug("listBefore:cacheHit", {
          threadId: tid,
          beforeId,
          count: cached.messages.length,
          pages: cached.pages,
          hasMore: cached.hasMore,
        });
        return { messages: cached.messages, hasMore: cached.hasMore };
      }

      L.debug("listBefore:cacheMiss", { threadId: tid, beforeId });
      const result = await set(
        remote.listMessagesBefore$,
        { threadId: tid, beforeId },
        signal,
      );

      const writeStore = stores.writeStore;
      await chatIdbWriteBestEffort(
        "cachedDataSource:upsertBefore",
        () => {
          return writeStore.upsertMessages(tid, result.messages, signal);
        },
        signal,
      );
      L.debug("listBefore:cacheFilled", {
        threadId: tid,
        beforeId,
        count: result.messages.length,
      });

      if (!result.hasMore) {
        const startMessageId = result.messages[0]?.id ?? beforeId;
        await chatIdbWriteBestEffort(
          "cachedDataSource:patchThreadMetaBefore",
          () => {
            return patchThreadMeta$(
              userId,
              orgId,
              tid,
              { startMessageId },
              signal,
            );
          },
          signal,
        );
      }

      return result;
    },
  );
}

function createListMessagesAfter(
  remote: ChatThreadDataSource,
  getStores: (userId: string, orgId: string) => Stores,
) {
  return command(
    async (
      { get, set },
      { threadId: tid, sinceId }: ListMessagesAfterArgs,
      signal: AbortSignal,
    ) => {
      const result = await set(
        remote.listMessagesAfter$,
        { threadId: tid, sinceId },
        signal,
      );

      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const userId = clerk.user?.id;
      const orgId = clerk.organization?.id;

      if (userId && orgId && result.messages.length > 0) {
        const stores = getStores(userId, orgId);
        // Only cache when the anchor (sinceId) still exists locally.
        // If it doesn't, local state has diverged and writing would create
        // a permanent gap between the last cached message and the new batch.
        if (sinceId) {
          const anchorExists = await chatIdbReadOr(
            "cachedDataSource:messageExists",
            () => {
              return stores.readStore.messageExists(tid, sinceId, signal);
            },
            false,
            signal,
          );
          if (!anchorExists) {
            L.debug("listAfter:anchorLost", { threadId: tid, sinceId });
            return result;
          }
        }
        await chatIdbWriteBestEffort(
          "cachedDataSource:upsertAfter",
          () => {
            return stores.writeStore.upsertMessages(
              tid,
              result.messages,
              signal,
            );
          },
          signal,
        );
        L.debug("listAfter:cacheFilled", {
          threadId: tid,
          sinceId,
          count: result.messages.length,
        });
      } else {
        L.debug("listAfter:skipCache", {
          threadId: tid,
          sinceId,
          hasAuth: Boolean(userId && orgId),
          count: result.messages.length,
        });
      }

      return result;
    },
  );
}

function createGetMessage(
  remote: ChatThreadDataSource,
  getStores: (userId: string, orgId: string) => Stores,
) {
  return command(
    async (
      { get, set },
      { threadId: tid, messageId }: GetMessageArgs,
      signal: AbortSignal,
    ) => {
      const message = await set(
        remote.getMessage$,
        { threadId: tid, messageId },
        signal,
      );
      signal.throwIfAborted();

      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const userId = clerk.user?.id;
      const orgId = clerk.organization?.id;

      if (!userId || !orgId || message === null) {
        return message;
      }

      const stores = getStores(userId, orgId);
      await chatIdbWriteBestEffort(
        "cachedDataSource:upsertMessage",
        () => {
          return stores.writeStore.upsertMessages(tid, [message], signal);
        },
        signal,
      );
      L.debug("getMessage:cacheFilled", { threadId: tid, messageId });
      return message;
    },
  );
}

export const warmLatestChatThreadMessages$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;

    if (!userId || !orgId) {
      L.debug("warmLatest:noAuth", { threadId });
      return;
    }

    const stores = createIdbMessageStores(userId, orgId);
    const latest = await chatIdbReadOr(
      "cachedDataSource:warmReadLatest",
      () => {
        return stores.readStore.readLatest(threadId, 1, signal);
      },
      [],
      signal,
    );
    signal.throwIfAborted();

    let sinceId = latest[0]?.id;
    let pages = 0;
    while (!signal.aborted) {
      const result = await set(
        warmListMessagesAfter$,
        { threadId, sinceId },
        signal,
      );
      signal.throwIfAborted();
      if (result === null) {
        return;
      }
      pages += 1;

      L.debug("warmLatest:page", {
        threadId,
        sinceId: sinceId ?? null,
        count: result.messages.length,
        reachedEnd: result.reachedEnd,
        pages,
      });

      if (result.messages.length > 0) {
        await chatIdbWriteBestEffort(
          "cachedDataSource:warmUpsert",
          () => {
            return stores.writeStore.upsertMessages(
              threadId,
              result.messages,
              signal,
            );
          },
          signal,
        );
        signal.throwIfAborted();
        const nextSinceId = result.messages[result.messages.length - 1]!.id;
        if (nextSinceId === sinceId) {
          break;
        }
        sinceId = nextSinceId;
      }

      if (result.reachedEnd) {
        break;
      }
    }
  },
);

function createSubscribeRealtime(remote: ChatThreadDataSource) {
  return command(
    (
      { set },
      { threadId: tid, handlers }: SubscribeRealtimeArgs,
      signal: AbortSignal,
    ) => {
      return set(
        remote.subscribeRealtime$,
        { threadId: tid, handlers },
        signal,
      );
    },
  );
}

export function createIdbCachedDataSource(
  threadId: string,
  onInitialPageCacheMiss?: () => void,
): ChatThreadDataSource {
  const remote = createRemoteChatThreadDataSource(threadId);

  let stores: Stores | null = null;

  function getStores(userId: string, orgId: string) {
    if (!stores) {
      stores = createIdbMessageStores(userId, orgId);
    }
    return stores;
  }

  const initialPage$ = computed(async (get): Promise<InitialPage> => {
    const clerk = await get(clerk$);
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;

    if (!userId || !orgId) {
      L.debug("initialPage:noAuth", { threadId });
      onInitialPageCacheMiss?.();
      return get(remote.initialPage$);
    }

    const stores = getStores(userId, orgId);
    const readStore = stores.readStore;
    const cached = await chatIdbReadOr(
      "cachedDataSource:initialReadLatest",
      () => {
        return readStore.readLatest(threadId);
      },
      [],
    );

    if (cached.length > 0) {
      const meta = await chatIdbReadOr(
        "cachedDataSource:initialReadThreadMeta",
        () => {
          return readThreadMeta$(userId, orgId, threadId);
        },
        null,
      );
      const startMessageId = meta?.startMessageId ?? null;
      const hasReachedStart = reachedStart(cached, startMessageId);
      const needsHistoryBackfill = !hasReachedStart && startMessageId === null;
      const hasHistoryBefore = !hasReachedStart && !needsHistoryBackfill;
      L.debug("initialPage:cacheHit", {
        threadId,
        count: cached.length,
        hasHistoryBefore,
        needsHistoryBackfill,
      });
      return { messages: cached, hasHistoryBefore, needsHistoryBackfill };
    }

    L.debug("initialPage:cacheMiss", { threadId });
    onInitialPageCacheMiss?.();
    const page = await get(remote.initialPage$);
    const writeStore = stores.writeStore;
    await chatIdbWriteBestEffort("cachedDataSource:initialUpsert", () => {
      return writeStore.upsertMessages(threadId, page.messages);
    });
    L.debug("initialPage:cacheFilled", {
      threadId,
      count: page.messages.length,
    });

    if (!page.hasHistoryBefore && page.messages.length > 0) {
      await chatIdbWriteBestEffort(
        "cachedDataSource:initialPatchThreadMeta",
        () => {
          return patchThreadMeta$(userId, orgId, threadId, {
            startMessageId: page.messages[0].id,
          });
        },
      );
    }

    return page;
  });

  const listMessagesAfter$ = createListMessagesAfter(remote, getStores);
  const getMessage$ = createGetMessage(remote, getStores);

  return {
    getThread$: remote.getThread$,
    reloadThread$: remote.reloadThread$,
    initialPage$,
    patchDraft$: remote.patchDraft$,
    patchModelSelection$: remote.patchModelSelection$,
    patchComputerUseHost$: remote.patchComputerUseHost$,
    appendQueuedMessage$: remote.appendQueuedMessage$,
    recallMessage$: remote.recallMessage$,
    listMessagesAfter$,
    listMessagesBefore$: createListMessagesBefore(remote, getStores),
    getMessage$,
    cancelRuns$: remote.cancelRuns$,
    markRead$: remote.markRead$,
    subscribeRealtime$: createSubscribeRealtime(remote),
  };
}
