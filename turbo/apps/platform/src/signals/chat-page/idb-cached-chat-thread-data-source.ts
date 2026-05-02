import { command, computed } from "ccstate";
import { clerk$ } from "../auth.ts";
import { createIdbMessageStores } from "../external/idb-message-store.ts";
import { logger } from "../log.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import type {
  ChatThreadDataSource,
  InitialPage,
  ListMessagesAfterArgs,
  ListMessagesBeforeArgs,
  SubscribeRealtimeArgs,
} from "./chat-thread-data-source.ts";

const L = logger("ChatIdbCache");

type Stores = ReturnType<typeof createIdbMessageStores>;

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
        L.debug("listBefore:cacheHit", {
          threadId: tid,
          beforeId,
          count: cached.length,
        });
        return { messages: cached, hasMore: true };
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
        const writeStore = stores.writeStore;
        await writeStore.upsertMessages(tid, result.messages, signal);
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
      return get(remote.initialPage$);
    }

    const stores = getStores(userId, orgId);
    const readStore = stores.readStore;
    const cached = await readStore.readLatest(threadId, 50);

    if (cached.length > 0) {
      L.debug("initialPage:cacheHit", { threadId, count: cached.length });
      return { messages: cached, hasHistoryBefore: true };
    }

    L.debug("initialPage:cacheMiss", { threadId });
    const page = await get(remote.initialPage$);
    const writeStore = stores.writeStore;
    await writeStore.upsertMessages(threadId, page.messages);
    L.debug("initialPage:cacheFilled", {
      threadId,
      count: page.messages.length,
    });

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
