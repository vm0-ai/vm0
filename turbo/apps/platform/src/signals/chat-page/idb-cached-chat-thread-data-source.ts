import { command, computed } from "ccstate";
import { clerk$ } from "../auth.ts";
import { createIdbMessageStores } from "../external/idb-message-store.ts";
import {
  patchThreadMeta$,
  readThreadMeta$,
} from "../external/idb-thread-meta-store.ts";
import { logger } from "../log.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import type {
  ChatThreadDataSource,
  InitialPage,
  ListMessagesAfterArgs,
  ListMessagesBeforeArgs,
  SubscribeRealtimeArgs,
} from "./chat-thread-data-source.ts";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";

const L = logger("ChatIdbCache");
const MESSAGE_PAGE_SIZE = 50;

type Stores = ReturnType<typeof createIdbMessageStores>;

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
    const page = await readStore.readBefore(
      threadId,
      cursorId,
      MESSAGE_PAGE_SIZE,
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
      const meta = await readThreadMeta$(userId, orgId, tid, signal);
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
      await writeStore.upsertMessages(tid, result.messages, signal);
      L.debug("listBefore:cacheFilled", {
        threadId: tid,
        beforeId,
        count: result.messages.length,
      });

      if (!result.hasMore) {
        const startMessageId = result.messages[0]?.id ?? beforeId;
        await patchThreadMeta$(userId, orgId, tid, { startMessageId }, signal);
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
          const anchorExists = await stores.readStore.messageExists(
            tid,
            sinceId,
            signal,
          );
          if (!anchorExists) {
            L.debug("listAfter:anchorLost", { threadId: tid, sinceId });
            return result;
          }
        }
        await stores.writeStore.upsertMessages(tid, result.messages, signal);
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
    const cached = await readStore.readLatest(threadId, MESSAGE_PAGE_SIZE);

    if (cached.length > 0) {
      const meta = await readThreadMeta$(userId, orgId, threadId);
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
    await writeStore.upsertMessages(threadId, page.messages);
    L.debug("initialPage:cacheFilled", {
      threadId,
      count: page.messages.length,
    });

    if (!page.hasHistoryBefore && page.messages.length > 0) {
      await patchThreadMeta$(userId, orgId, threadId, {
        startMessageId: page.messages[0].id,
      });
    }

    return page;
  });

  const listMessagesAfter$ = createListMessagesAfter(remote, getStores);

  return {
    getThread$: remote.getThread$,
    reloadThread$: remote.reloadThread$,
    initialPage$,
    patchDraft$: remote.patchDraft$,
    patchModelSelection$: remote.patchModelSelection$,
    appendQueuedMessage$: remote.appendQueuedMessage$,
    recallMessage$: remote.recallMessage$,
    listMessagesAfter$,
    listMessagesBefore$: createListMessagesBefore(remote, getStores),
    cancelRuns$: remote.cancelRuns$,
    markRead$: remote.markRead$,
    subscribeRealtime$: createSubscribeRealtime(remote),
  };
}
