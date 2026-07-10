import { command, computed, state } from "ccstate";
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
import { setLoop } from "../utils.ts";
import { createIdbMessageStores } from "../external/idb-message-store.ts";
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
const threadStartMessageIds$ = state<ReadonlyMap<string, string>>(new Map());

type Stores = ReturnType<typeof createIdbMessageStores>;
type ListMessagesAfterResult = {
  messages: PagedChatMessage[];
  reachedEnd: boolean;
};

function threadStartMessageKey(
  userId: string,
  orgId: string,
  threadId: string,
): string {
  return `${userId}:${orgId}:${threadId}`;
}

function readThreadStartMessageId(
  threadStartMessageIds: ReadonlyMap<string, string>,
  userId: string,
  orgId: string,
  threadId: string,
): string | null {
  return (
    threadStartMessageIds.get(threadStartMessageKey(userId, orgId, threadId)) ??
    null
  );
}

function rememberThreadStartMessageId(
  threadStartMessageIds: ReadonlyMap<string, string>,
  userId: string,
  orgId: string,
  threadId: string,
  startMessageId: string,
): ReadonlyMap<string, string> {
  const next = new Map(threadStartMessageIds);
  next.set(threadStartMessageKey(userId, orgId, threadId), startMessageId);
  return next;
}

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

  await setLoop(
    async (loopSignal) => {
      const page = await chatIdbReadOr(
        "cachedDataSource:readBefore",
        () => {
          return readStore.readBefore(
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

      if (
        reachedStart(newMessages, startMessageId) ||
        page.length < MESSAGE_PAGE_SIZE
      ) {
        return true;
      }

      cursorId = newMessages[0]!.id;
      return false;
    },
    0,
    signal,
  );

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
      const { userId, orgId } = await get(authenticatedIdentity$);
      signal.throwIfAborted();

      const stores = getStores(userId, orgId);
      const readStore = stores.readStore;
      const cached = await readCachedMessagesBeforeUntilMiss(
        readStore,
        tid,
        beforeId,
        readThreadStartMessageId(
          get(threadStartMessageIds$),
          userId,
          orgId,
          tid,
        ),
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
        set(threadStartMessageIds$, (previous) => {
          return rememberThreadStartMessageId(
            previous,
            userId,
            orgId,
            tid,
            startMessageId,
          );
        });
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

      if (result.messages.length > 0) {
        const { userId, orgId } = await get(authenticatedIdentity$);
        signal.throwIfAborted();
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

      if (message === null) {
        return message;
      }

      const { userId, orgId } = await get(authenticatedIdentity$);
      signal.throwIfAborted();
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
    const { userId, orgId } = await get(authenticatedIdentity$);
    signal.throwIfAborted();
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
    await setLoop(
      async (loopSignal) => {
        const result = await set(
          warmListMessagesAfter$,
          { threadId, sinceId },
          loopSignal,
        );
        loopSignal.throwIfAborted();
        if (result === null) {
          return true;
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
                loopSignal,
              );
            },
            loopSignal,
          );
          loopSignal.throwIfAborted();
          const nextSinceId = result.messages[result.messages.length - 1]!.id;
          if (nextSinceId === sinceId) {
            return true;
          }
          sinceId = nextSinceId;
        }

        if (result.reachedEnd) {
          return true;
        }
        return false;
      },
      0,
      signal,
    );
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
    const { userId, orgId } = await get(authenticatedIdentity$);
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
      const startMessageId = readThreadStartMessageId(
        get(threadStartMessageIds$),
        userId,
        orgId,
        threadId,
      );
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
    const page = await get(remote.initialPage$);
    const writeStore = stores.writeStore;
    await chatIdbWriteBestEffort("cachedDataSource:initialUpsert", () => {
      return writeStore.upsertMessages(threadId, page.messages);
    });
    L.debug("initialPage:cacheFilled", {
      threadId,
      count: page.messages.length,
    });

    return page;
  });

  const listMessagesAfter$ = createListMessagesAfter(remote, getStores);
  const getMessage$ = createGetMessage(remote, getStores);

  return {
    remoteThreadDetail$: remote.remoteThreadDetail$,
    threadDraft$: remote.threadDraft$,
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
