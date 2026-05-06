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

type Stores = ReturnType<typeof createIdbMessageStores>;

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
      const cached = await readStore.readBefore(tid, beforeId, 50, signal);

      if (cached.length > 0) {
        const meta = await readThreadMeta$(userId, orgId, tid, signal);
        const hasMore = !reachedStart(cached, meta?.startMessageId ?? null);
        L.debug("listBefore:cacheHit", {
          threadId: tid,
          beforeId,
          count: cached.length,
          hasMore,
        });
        return { messages: cached, hasMore };
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
        // Remote confirms we've reached the start. Persist the first message
        // id (or `beforeId` itself when there were no older messages) so
        // subsequent cache hits can compute hasMore without re-fetching.
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
    const cached = await readStore.readLatest(threadId, 50);

    if (cached.length > 0) {
      const meta = await readThreadMeta$(userId, orgId, threadId);
      const hasHistoryBefore = !reachedStart(
        cached,
        meta?.startMessageId ?? null,
      );
      L.debug("initialPage:cacheHit", {
        threadId,
        count: cached.length,
        hasHistoryBefore,
      });
      return { messages: cached, hasHistoryBefore };
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
      // Remote confirms the latest page already contains the very first
      // message. Persist its id so subsequent cache hits don't show a
      // phantom "Load history" button.
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
    listMessagesAfter$,
    listMessagesBefore$: createListMessagesBefore(remote, getStores),
    cancelRuns$: remote.cancelRuns$,
    markRead$: remote.markRead$,
    subscribeRealtime$: createSubscribeRealtime(remote),
  };
}
