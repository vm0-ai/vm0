import { command } from "ccstate";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { foregroundReady$ } from "../auth-retry.ts";
import { logger } from "../log.ts";
import { setAblyMessageLoop$ } from "../realtime.ts";
import {
  clearIndexedDbChatEventRows$,
  loadIndexedDbChatEventCursor$,
  replaceIndexedDbChatEventRows$,
  writeIndexedDbChatEventRows$,
} from "./chat-event-row-indexed-db.ts";
import {
  fetchChatEventSnapshotRows$,
  listRowsAfter$,
} from "./remote-chat-event-row-data-source.ts";
import { receiveActiveChatEvents$ } from "./chat-event-signal-registry.ts";
import { allUnreadThreadIds$ } from "./chat-thread-indicators.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";
import {
  chatEventDebugSummaries,
  chatEventTraceTime,
} from "./chat-event-debug.ts";
import { queryChatEventSharedDatabase$ } from "../shared-database.ts";

const L = logger("ChatEventBackgroundSync");
const CHAT_THREAD_MESSAGE_CREATED_PREFIX = "chatThreadMessageCreated:";
const BACKGROUND_UNREAD_THREAD_LIMIT = 10;
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
    readonly cursor: ChatEventCursor;
  }> => {
    const result = await set(fetchChatEventSnapshotRows$, threadId, signal);
    const snapshot = result.snapshot;
    const cursor: ChatEventCursor =
      snapshot === null || snapshot.lastEventId === null
        ? { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID }
        : {
            lastEventId: snapshot.lastEventId,
            lastSeqId: snapshot.lastSeqId,
          };
    await set(
      replaceIndexedDbChatEventRows$,
      {
        threadId,
        rows: snapshot?.rows ?? [],
        cursor,
      },
      signal,
    );
    return {
      events: (snapshot?.rows ?? []).map((row) => {
        return chatEventFromRow(row);
      }),
      cursor,
    };
  },
);

/**
 * Canonical-row background sync: cold-starts an empty raw-row cache from the
 * archive, then tails it through the raw-row endpoint. An expired cursor
 * rebuilds the cache in the same pass.
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
    const cachedCursor = await set(
      loadIndexedDbChatEventCursor$,
      threadId,
      signal,
    );
    signal.throwIfAborted();
    if (
      cachedCursor !== null &&
      syncThroughSeqId !== null &&
      cachedCursor.lastSeqId >= syncThroughSeqId
    ) {
      L.debug("skipped background row sync: seq watermark already cached", {
        threadId,
        syncThroughSeqId,
      });
      return [];
    }

    const syncedEvents: ChatEvent[] = [];
    let cursorFromServer = false;
    let cursor: ChatEventCursor;
    if (cachedCursor === null) {
      const coldStart = await set(coldStartChatThreadRows$, threadId, signal);
      syncedEvents.push(...coldStart.events);
      cursor = coldStart.cursor;
      cursorFromServer = true;
    } else {
      cursor = cachedCursor;
    }

    let shouldLoadNextPage = true;
    while (shouldLoadNextPage) {
      const page = await set(listRowsAfter$, { threadId, cursor }, signal);
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
        cursor = coldStart.cursor;
        cursorFromServer = true;
        continue;
      }
      cursor = page.cursor;
      await set(
        writeIndexedDbChatEventRows$,
        {
          threadId,
          rows: page.rows,
          cursor,
        },
        signal,
      );
      syncedEvents.push(
        ...page.rows.map((row) => {
          return chatEventFromRow(row);
        }),
      );
      shouldLoadNextPage = page.hasMore;
    }
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
      syncChatThreadRowsToIndexedDb$,
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

const catchUpOpenAndUnreadChatThreadEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const foregroundReady = get(foregroundReady$);
    await foregroundReady.promise;
    signal.throwIfAborted();

    const allUnreadThreadIds = await get(allUnreadThreadIds$);
    signal.throwIfAborted();
    const openThreadIds = new Set<string>();
    for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (thread !== null) {
        openThreadIds.add(thread.threadId);
      }
    }
    const unreadThreadIds = Array.from(allUnreadThreadIds)
      .filter((threadId) => {
        return !openThreadIds.has(threadId);
      })
      .slice(0, BACKGROUND_UNREAD_THREAD_LIMIT);
    const threadIds = [...openThreadIds, ...unreadThreadIds];
    await Promise.all(
      threadIds.map((threadId) => {
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
        catchUpCommand$: catchUpOpenAndUnreadChatThreadEvents$,
      },
      signal,
    );
  },
);

const syncInitialUnreadChatThreadEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const unreadThreadIds = await get(allUnreadThreadIds$);
    signal.throwIfAborted();

    const threadIds = Array.from(unreadThreadIds).slice(
      0,
      BACKGROUND_UNREAD_THREAD_LIMIT,
    );
    await Promise.all(
      threadIds.map((threadId) => {
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
      set(syncInitialUnreadChatThreadEvents$, signal),
    ]);
  },
);

export const prewarmSharedUnreadChatEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const unreadThreadIds = await get(allUnreadThreadIds$);
    signal.throwIfAborted();
    await Promise.all(
      Array.from(unreadThreadIds)
        .slice(0, BACKGROUND_UNREAD_THREAD_LIMIT)
        .map((threadId) => {
          return set(
            queryChatEventSharedDatabase$,
            {
              dataKey: {
                kind: "chat-event",
                threadId,
              },
              afterSeqId: null,
              consistency: "catch-up",
            },
            signal,
          );
        }),
    );
  },
);
