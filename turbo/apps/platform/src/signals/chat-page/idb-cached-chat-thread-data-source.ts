import { command, computed } from "ccstate";
import { clerk$ } from "../auth.ts";
import { createIdbMessageStores } from "../external/idb-message-store.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import type {
  ChatThreadDataSource,
  InitialPage,
  ListMessagesAfterArgs,
  ListMessagesBeforeArgs,
  SubscribeRealtimeArgs,
} from "./chat-thread-data-source.ts";

export function createIdbCachedDataSource(
  threadId: string,
): ChatThreadDataSource {
  const remote = createRemoteChatThreadDataSource(threadId);

  let initialPageFromCache = false;
  let stores: ReturnType<typeof createIdbMessageStores> | null = null;

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
      initialPageFromCache = false;
      return get(remote.initialPage$);
    }

    const stores = getStores(userId, orgId);
    const readStore = stores.readStore$;
    const cached = await readStore.readLatest(threadId, 50);

    if (cached.length > 0) {
      initialPageFromCache = true;
      return { messages: cached, hasHistoryBefore: true };
    }

    initialPageFromCache = false;
    const page = await get(remote.initialPage$);
    const writeStore = stores.writeStore$;
    await writeStore.upsertMessages(threadId, page.messages);

    return page;
  });

  const listMessagesBefore$ = command(
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
        return set(
          remote.listMessagesBefore$,
          { threadId: tid, beforeId },
          signal,
        );
      }

      const stores = getStores(userId, orgId);
      const readStore = stores.readStore$;
      const cached = await readStore.readBefore(tid, beforeId, 50, signal);

      if (cached.length > 0) {
        return { messages: cached, hasMore: true };
      }

      const result = await set(
        remote.listMessagesBefore$,
        { threadId: tid, beforeId },
        signal,
      );

      const writeStore = stores.writeStore$;
      await writeStore.upsertMessages(tid, result.messages, signal);

      return result;
    },
  );

  const listMessagesAfter$ = command(
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
        const writeStore = stores.writeStore$;
        await writeStore.upsertMessages(tid, result.messages, signal);
      }

      return result;
    },
  );

  const subscribeRealtime$ = command(
    async (
      { get, set },
      { threadId: tid, handlers }: SubscribeRealtimeArgs,
      signal: AbortSignal,
    ) => {
      if (initialPageFromCache) {
        const page = await get(initialPage$);
        signal.throwIfAborted();
        const latestMessageId = page.messages[page.messages.length - 1]?.id;
        if (latestMessageId) {
          await set(
            listMessagesAfter$,
            { threadId: tid, sinceId: latestMessageId },
            signal,
          );
        }
      }

      return set(
        remote.subscribeRealtime$,
        { threadId: tid, handlers },
        signal,
      );
    },
  );

  return {
    getThread$: remote.getThread$,
    reloadThread$: remote.reloadThread$,
    initialPage$,
    patchDraft$: remote.patchDraft$,
    listMessagesAfter$,
    listMessagesBefore$,
    cancelRuns$: remote.cancelRuns$,
    markRead$: remote.markRead$,
    subscribeRealtime$,
    isCancelRequested$: remote.isCancelRequested$,
  };
}
