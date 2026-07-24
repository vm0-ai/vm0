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
import { listEventsAfter$ } from "./remote-chat-thread-data-source.ts";

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

const syncChatThreadEventsToIndexedDb$ = command(
  async (
    { set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<ChatEvent[]> => {
    const bounds = await set(loadIndexedDbChatEventBounds$, threadId, signal);
    signal.throwIfAborted();

    const syncedEvents: ChatEvent[] = [];
    let sinceSeqId = bounds.last?.seqId;

    async function syncEventsAfter(): Promise<void> {
      const result = await set(
        listEventsAfter$,
        { threadId, sinceSeqId },
        signal,
      );
      signal.throwIfAborted();

      if (result.events.length === 0) {
        return;
      }

      await set(writeIndexedDbChatEvents$, threadId, result.events, signal);
      signal.throwIfAborted();
      syncedEvents.push(...result.events);
      sinceSeqId = result.events[result.events.length - 1]!.seqId;
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
        await set(thread.receiveSyncedEvents$, events, signal);
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

    const events = await set(
      syncChatThreadEventsToIndexedDb$,
      threadId,
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

const subscribeChatEventBackgroundSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(
      setAblyMessageLoop$,
      { loopCommand$: handleUserChannelMessage$ },
      signal,
    );
  },
);

export const setupChatEventBackgroundSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(subscribeChatEventBackgroundSync$, signal);
  },
);
