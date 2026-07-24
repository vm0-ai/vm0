import { command } from "ccstate";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { searchParams$ } from "../route.ts";
import { setAblyMessageLoop$ } from "../realtime.ts";
import {
  loadIndexedDbChatMessageBounds$,
  writeIndexedDbChatMessages$,
} from "./chat-message-indexed-db.ts";
import {
  currentLeftThread$,
  currentRightThread$,
  SIDEBAR_PARAM,
} from "./chat-thread-panes.ts";
import {
  CHAT_MESSAGES_PAGE_LIMIT,
  listMessagesAfter$,
} from "./remote-chat-thread-data-source.ts";
import { logger } from "../log.ts";

const L = logger("ChatMessageBackgroundSync");
const CHAT_THREAD_MESSAGE_CREATED_PREFIX = "chatThreadMessageCreated:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createdMessageThreadId(message: unknown): string | null {
  if (
    typeof message !== "object" ||
    message === null ||
    !("name" in message) ||
    typeof message.name !== "string" ||
    !message.name.startsWith(CHAT_THREAD_MESSAGE_CREATED_PREFIX)
  ) {
    return null;
  }
  const threadId = message.name.slice(
    CHAT_THREAD_MESSAGE_CREATED_PREFIX.length,
  );
  return UUID_PATTERN.test(threadId) ? threadId : null;
}

function createdMessageSyncThroughSeqId(message: unknown): number | null {
  if (
    typeof message !== "object" ||
    message === null ||
    !("data" in message) ||
    typeof message.data !== "object" ||
    message.data === null ||
    !("syncThroughSeqId" in message.data) ||
    typeof message.data.syncThroughSeqId !== "number" ||
    !Number.isSafeInteger(message.data.syncThroughSeqId) ||
    message.data.syncThroughSeqId <= 0
  ) {
    return null;
  }
  return message.data.syncThroughSeqId;
}

const syncChatThreadMessagesToIndexedDb$ = command(
  async (
    { set },
    {
      threadId,
      syncThroughSeqId,
    }: {
      readonly threadId: string;
      readonly syncThroughSeqId: number | null;
    },
    signal: AbortSignal,
  ): Promise<PagedChatMessage[]> => {
    const bounds = await set(loadIndexedDbChatMessageBounds$, threadId, signal);
    signal.throwIfAborted();

    if (
      syncThroughSeqId !== null &&
      bounds.last !== null &&
      bounds.last.seqId >= syncThroughSeqId
    ) {
      L.debug("skipped background sync: seq watermark already cached", {
        threadId,
        syncThroughSeqId,
      });
      return [];
    }

    const syncedMessages: PagedChatMessage[] = [];
    let sinceSeqId = bounds.last?.seqId;

    async function syncMessagesAfter(): Promise<void> {
      const requestedSinceSeqId = sinceSeqId;
      const result = await set(
        listMessagesAfter$,
        { threadId, sinceSeqId: requestedSinceSeqId },
        signal,
      );
      signal.throwIfAborted();

      if (result.messages.length === 0) {
        return;
      }

      await set(writeIndexedDbChatMessages$, threadId, result.messages, signal);
      signal.throwIfAborted();
      syncedMessages.push(...result.messages);
      sinceSeqId = result.messages[result.messages.length - 1]!.seqId;
      if (
        requestedSinceSeqId !== undefined &&
        result.messages.length < CHAT_MESSAGES_PAGE_LIMIT
      ) {
        return;
      }
      await syncMessagesAfter();
    }

    await syncMessagesAfter();
    signal.throwIfAborted();
    L.debug("synced chat messages to IndexedDB", { threadId });
    return syncedMessages;
  },
);

const receiveSyncedMessagesInVisibleThreads$ = command(
  async (
    { get, set },
    {
      threadId,
      messages,
    }: {
      threadId: string;
      messages: PagedChatMessage[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const mainThreadId = get(currentChatThreadId$);
    if (mainThreadId === null) {
      return;
    }

    const sidebarThreadId = get(searchParams$).get(SIDEBAR_PARAM);
    const leftThread = get(currentLeftThread$);
    const rightThread = get(currentRightThread$);
    const visibleThreads = [
      mainThreadId === threadId && leftThread?.threadId === threadId
        ? leftThread
        : null,
      sidebarThreadId === threadId && rightThread?.threadId === threadId
        ? rightThread
        : null,
    ].filter((thread) => {
      return thread !== null;
    });

    await Promise.all(
      visibleThreads.map(async (thread) => {
        await set(thread.receiveSyncedMessages$, messages, signal);
      }),
    );
    signal.throwIfAborted();
  },
);

const handleUserChannelMessage$ = command(
  async ({ set }, message: unknown, signal: AbortSignal): Promise<boolean> => {
    const threadId = createdMessageThreadId(message);
    if (!threadId) {
      return false;
    }

    const syncThroughSeqId = createdMessageSyncThroughSeqId(message);
    const messages = await set(
      syncChatThreadMessagesToIndexedDb$,
      { threadId, syncThroughSeqId },
      signal,
    );
    signal.throwIfAborted();
    await set(
      receiveSyncedMessagesInVisibleThreads$,
      { threadId, messages },
      signal,
    );
    signal.throwIfAborted();
    return false;
  },
);

const catchUpVisibleChatThreadMessages$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const mainThreadId = get(currentChatThreadId$);
    const sidebarThreadId = get(searchParams$).get(SIDEBAR_PARAM);
    const leftThreadId = get(currentLeftThread$)?.threadId;
    const rightThreadId = get(currentRightThread$)?.threadId;
    const visibleThreadIds = new Set<string>();

    if (mainThreadId !== null && leftThreadId === mainThreadId) {
      visibleThreadIds.add(mainThreadId);
    }
    if (sidebarThreadId !== null && rightThreadId === sidebarThreadId) {
      visibleThreadIds.add(sidebarThreadId);
    }

    await Promise.all(
      Array.from(visibleThreadIds, async (threadId) => {
        const messages = await set(
          syncChatThreadMessagesToIndexedDb$,
          { threadId, syncThroughSeqId: null },
          signal,
        );
        signal.throwIfAborted();
        await set(
          receiveSyncedMessagesInVisibleThreads$,
          { threadId, messages },
          signal,
        );
      }),
    );
    signal.throwIfAborted();
    return false;
  },
);

const subscribeChatMessageBackgroundSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(
      setAblyMessageLoop$,
      {
        loopCommand$: handleUserChannelMessage$,
        catchUpCommand$: catchUpVisibleChatThreadMessages$,
      },
      signal,
    );
  },
);

export const setupChatMessageBackgroundSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(subscribeChatMessageBackgroundSync$, signal);
  },
);
