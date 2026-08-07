import { command } from "ccstate";
import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { logger } from "../log.ts";
import { setAblyMessageLoop$ } from "../realtime.ts";
import {
  loadIndexedDbChatEventBounds$,
  writeIndexedDbChatEvents$,
} from "./chat-event-indexed-db.ts";
import {
  CHAT_EVENTS_PAGE_LIMIT,
  listEventsAfter$,
} from "./remote-chat-event-data-source.ts";
import {
  activeChatEventThreadIds$,
  receiveActiveChatEvents$,
} from "./chat-event-signal-registry.ts";
import { sidebarActiveThreadIds$ } from "./chat-thread-event-sourcing.ts";
import { allUnreadThreadIds$ } from "./sidebar-unread-threads.ts";

const L = logger("ChatEventBackgroundSync");
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

const syncChatThreadEventsToIndexedDb$ = command(
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
  ): Promise<ChatEvent[]> => {
    const bounds = await set(loadIndexedDbChatEventBounds$, threadId, signal);
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

    const syncedEvents: ChatEvent[] = [];
    let sinceSeqId = bounds.last?.seqId;

    async function syncEventsAfter(): Promise<void> {
      const requestedSinceSeqId = sinceSeqId;
      const events = await set(
        listEventsAfter$,
        { threadId, sinceSeqId: requestedSinceSeqId },
        signal,
      );
      signal.throwIfAborted();

      if (events.length === 0) {
        return;
      }

      await set(writeIndexedDbChatEvents$, threadId, events, signal);
      signal.throwIfAborted();
      syncedEvents.push(...events);
      sinceSeqId = events[events.length - 1]!.seqId;
      if (
        requestedSinceSeqId !== undefined &&
        events.length < CHAT_EVENTS_PAGE_LIMIT
      ) {
        return;
      }
      await syncEventsAfter();
    }

    await syncEventsAfter();
    signal.throwIfAborted();
    L.debug("synced chat events to IndexedDB", { threadId });
    return syncedEvents;
  },
);

const handleUserChannelMessage$ = command(
  async ({ set }, message: unknown, signal: AbortSignal): Promise<boolean> => {
    const threadId = createdMessageThreadId(message);
    if (!threadId) {
      return false;
    }

    const syncThroughSeqId = createdMessageSyncThroughSeqId(message);
    const events = await set(
      syncChatThreadEventsToIndexedDb$,
      { threadId, syncThroughSeqId },
      signal,
    );
    signal.throwIfAborted();
    await set(receiveActiveChatEvents$, threadId, events, signal);
    signal.throwIfAborted();
    return false;
  },
);

const catchUpVisibleChatThreadEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    await Promise.all(
      get(activeChatEventThreadIds$).map(async (threadId) => {
        const events = await set(
          syncChatThreadEventsToIndexedDb$,
          { threadId, syncThroughSeqId: null },
          signal,
        );
        signal.throwIfAborted();
        await set(receiveActiveChatEvents$, threadId, events, signal);
      }),
    );
    signal.throwIfAborted();
    return false;
  },
);

const subscribeChatEventBackgroundSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(
      setAblyMessageLoop$,
      {
        loopCommand$: handleUserChannelMessage$,
        catchUpCommand$: catchUpVisibleChatThreadEvents$,
      },
      signal,
    );
  },
);

const syncInitialUnreadAndActiveChatThreadEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const [unreadThreadIds, activeThreadIds] = await Promise.all([
      get(allUnreadThreadIds$),
      get(sidebarActiveThreadIds$),
    ]);
    signal.throwIfAborted();

    const threadIds = new Set([...unreadThreadIds, ...activeThreadIds]);
    await Promise.all(
      Array.from(threadIds, (threadId) => {
        return set(
          handleUserChannelMessage$,
          { name: `${CHAT_THREAD_MESSAGE_CREATED_PREFIX}${threadId}` },
          signal,
        );
      }),
    );
  },
);

export const setupChatEventBackgroundSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await Promise.all([
      set(subscribeChatEventBackgroundSync$, signal),
      set(syncInitialUnreadAndActiveChatThreadEvents$, signal),
    ]);
  },
);
