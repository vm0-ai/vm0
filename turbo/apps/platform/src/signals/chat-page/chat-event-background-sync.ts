import { command } from "ccstate";
import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { logger } from "../log.ts";
import { setAblyMessageLoop$ } from "../realtime.ts";
import { searchParams$ } from "../route.ts";
import {
  loadIndexedDbChatEventBounds$,
  writeIndexedDbChatEvents$,
} from "./chat-event-indexed-db.ts";
import {
  currentLeftThread$,
  currentRightThread$,
  SIDEBAR_PARAM,
} from "./chat-thread-panes.ts";
import { autoOpenThreadSidebar$ } from "./thread-sidebar-coordinator.ts";
import {
  CHAT_EVENTS_PAGE_LIMIT,
  listEventsAfter$,
} from "./remote-chat-thread-data-source.ts";

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

const receiveSyncedEventsInVisibleThreads$ = command(
  async (
    { get, set },
    {
      threadId,
      events,
    }: {
      threadId: string;
      events: ChatEvent[];
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
        // Receiving merges the new events before it awaits read-state work, so
        // start it first and let sidebar selection proceed from that projection.
        const receiveEventsPromise = set(
          thread.receiveSyncedEvents$,
          events,
          signal,
        );
        if (events.length === 0) {
          await receiveEventsPromise;
          return;
        }
        await Promise.all([
          receiveEventsPromise,
          set(autoOpenThreadSidebar$, thread, signal),
        ]);
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
    const events = await set(
      syncChatThreadEventsToIndexedDb$,
      { threadId, syncThroughSeqId },
      signal,
    );
    signal.throwIfAborted();
    await set(
      receiveSyncedEventsInVisibleThreads$,
      { threadId, events },
      signal,
    );
    signal.throwIfAborted();
    return false;
  },
);

const catchUpVisibleChatThreadEvents$ = command(
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
        const events = await set(
          syncChatThreadEventsToIndexedDb$,
          { threadId, syncThroughSeqId: null },
          signal,
        );
        signal.throwIfAborted();
        await set(
          receiveSyncedEventsInVisibleThreads$,
          { threadId, events },
          signal,
        );
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

export const setupChatEventBackgroundSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(subscribeChatEventBackgroundSync$, signal);
  },
);
