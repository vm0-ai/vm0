import { command } from "ccstate";
import { chatEventFromRow } from "@vm0/api-contracts/contracts/chat-event-row-projection";
import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { foregroundReady$ } from "../auth-retry.ts";
import { chatEventSnapshotReadEnabled$ } from "../external/feature-switch.ts";
import { logger } from "../log.ts";
import { setAblyMessageLoop$ } from "../realtime.ts";
import {
  loadIndexedDbChatEventBounds$,
  writeIndexedDbChatEvents$,
} from "./chat-event-indexed-db.ts";
import {
  clearIndexedDbChatEventRows$,
  loadIndexedDbChatEventRowLastSeqId$,
  writeIndexedDbChatEventRows$,
} from "./chat-event-row-indexed-db.ts";
import {
  CHAT_EVENTS_PAGE_LIMIT,
  listEventsAfter$,
} from "./remote-chat-event-data-source.ts";
import {
  CHAT_EVENT_ROWS_PAGE_LIMIT,
  fetchChatEventSnapshotRows$,
  listRowsAfter$,
} from "./remote-chat-event-row-data-source.ts";
import { receiveActiveChatEvents$ } from "./chat-event-signal-registry.ts";
import {
  allUnreadThreadIds$,
  sidebarActiveThreadIds$,
} from "./chat-thread-indicators.ts";
import {
  chatEventDebugSummaries,
  chatEventTraceTime,
} from "./chat-event-debug.ts";

const L = logger("ChatEventBackgroundSync");
const CHAT_THREAD_MESSAGE_CREATED_PREFIX = "chatThreadMessageCreated:";
const THREAD_START_SEQ_ID = 0;
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

const coldStartChatThreadRows$ = command(
  async (
    { set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly events: readonly ChatEvent[];
    readonly lastSeqId: number;
  }> => {
    const snapshot = await set(fetchChatEventSnapshotRows$, threadId, signal);
    if (snapshot === null) {
      return { events: [], lastSeqId: THREAD_START_SEQ_ID };
    }
    await set(writeIndexedDbChatEventRows$, snapshot.rows, signal);
    return {
      events: snapshot.rows.map((row) => {
        return chatEventFromRow(row);
      }),
      lastSeqId: snapshot.lastSeqId,
    };
  },
);

/**
 * Snapshot-read variant: cold-starts an empty raw-row cache from the archive,
 * then tails it through the raw-row endpoint. An expired cursor rebuilds the
 * cache in the same pass.
 */
const syncChatThreadRowsToIndexedDb$ = command(
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
    const lastSeqId = await set(
      loadIndexedDbChatEventRowLastSeqId$,
      threadId,
      signal,
    );
    signal.throwIfAborted();
    if (
      lastSeqId !== null &&
      syncThroughSeqId !== null &&
      lastSeqId >= syncThroughSeqId
    ) {
      L.debug("skipped background row sync: seq watermark already cached", {
        threadId,
        syncThroughSeqId,
      });
      return [];
    }

    const syncedEvents: ChatEvent[] = [];
    let cursorFromServer = false;
    let sinceSeqId: number;
    if (lastSeqId === null) {
      const coldStart = await set(coldStartChatThreadRows$, threadId, signal);
      syncedEvents.push(...coldStart.events);
      sinceSeqId = coldStart.lastSeqId;
      cursorFromServer = true;
    } else {
      sinceSeqId = lastSeqId;
    }

    let shouldLoadNextPage = true;
    while (shouldLoadNextPage) {
      const page = await set(listRowsAfter$, { threadId, sinceSeqId }, signal);
      signal.throwIfAborted();
      if (page.kind === "expired") {
        if (cursorFromServer) {
          throw new Error(
            "chat event rows cursor expired right after a background cold start",
          );
        }
        await set(clearIndexedDbChatEventRows$, threadId, signal);
        const coldStart = await set(coldStartChatThreadRows$, threadId, signal);
        syncedEvents.push(...coldStart.events);
        sinceSeqId = coldStart.lastSeqId;
        cursorFromServer = true;
        continue;
      }
      if (page.rows.length === 0) {
        return syncedEvents;
      }
      await set(writeIndexedDbChatEventRows$, page.rows, signal);
      signal.throwIfAborted();
      syncedEvents.push(
        ...page.rows.map((row) => {
          return chatEventFromRow(row);
        }),
      );
      sinceSeqId = page.rows.at(-1)!.seqId;
      shouldLoadNextPage = page.rows.length === CHAT_EVENT_ROWS_PAGE_LIMIT;
    }
    return syncedEvents;
  },
);

const syncChatThreadEventsToIndexedDb$ = command(
  async (
    { get, set },
    {
      threadId,
      syncThroughSeqId,
    }: {
      readonly threadId: string;
      readonly syncThroughSeqId: number | null;
    },
    signal: AbortSignal,
  ): Promise<ChatEvent[]> => {
    if (get(chatEventSnapshotReadEnabled$)) {
      return await set(
        syncChatThreadRowsToIndexedDb$,
        { threadId, syncThroughSeqId },
        signal,
      );
    }
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
    L.debug("chat event notification received", {
      traceTime: chatEventTraceTime(),
      threadId,
      syncThroughSeqId,
    });
    const events = await set(
      syncChatThreadEventsToIndexedDb$,
      { threadId, syncThroughSeqId },
      signal,
    );
    signal.throwIfAborted();
    L.debug("chat event notification synced", {
      traceTime: chatEventTraceTime(),
      threadId,
      syncThroughSeqId,
      count: events.length,
      events: chatEventDebugSummaries(events),
    });
    await set(receiveActiveChatEvents$, threadId, events, signal);
    signal.throwIfAborted();
    return false;
  },
);

const catchUpUnreadChatThreadEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const foregroundReady = get(foregroundReady$);
    await foregroundReady.promise;
    signal.throwIfAborted();

    const unreadThreadIds = await get(allUnreadThreadIds$);
    signal.throwIfAborted();
    await Promise.all(
      Array.from(unreadThreadIds, (threadId) => {
        return set(
          handleUserChannelMessage$,
          { name: `${CHAT_THREAD_MESSAGE_CREATED_PREFIX}${threadId}` },
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
        catchUpCommand$: catchUpUnreadChatThreadEvents$,
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
