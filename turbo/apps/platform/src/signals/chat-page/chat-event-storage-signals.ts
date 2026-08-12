import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type { ChatEventRowV4 } from "@vm0/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@vm0/api-contracts/contracts/chat-event-row-projection";
import type { ChatEvent as PersistedChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { captureTaskCompletedSuccessfully } from "../../lib/posthog.ts";
import { settle } from "../utils.ts";
import { notifyChatEventsChanged$ } from "./chat-event-change-registry.ts";
import {
  clearIndexedDbChatEventRows$,
  loadIndexedDbChatEventRowsAfter$,
  writeIndexedDbChatEventRows$,
} from "./chat-event-row-indexed-db.ts";
import {
  CHAT_EVENT_ROWS_PAGE_LIMIT,
  fetchChatEventSnapshotRows$,
  listRowsAfter$,
} from "./remote-chat-event-row-data-source.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import {
  appendOptimisticChatEvent$,
  createOptimisticChatEventEntry,
  createOptimisticChatEventsForThread,
  reconcileOptimisticChatEvents$,
  type OptimisticChatEventEntry,
  type OptimisticChatEventInput,
} from "./optimistic-chat-events.ts";
/** Cursor that reads a thread from its very first event. */
const THREAD_START_SEQ_ID = 0;

export type AppendOptimisticEventCommand = Command<
  Promise<void>,
  [OptimisticChatEventInput, AbortSignal]
>;

type PersistentChatEvents$ = State<PersistedChatEvent[]>;

function completedRunIdsFromEvents(
  events: readonly PersistedChatEvent[],
): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.eventType === "run.completed" && event.runId !== undefined) {
      ids.add(event.runId);
    }
  }
  return Array.from(ids);
}

function reportNewCompletedRuns({
  persistentEvents,
  events,
}: {
  persistentEvents: readonly PersistedChatEvent[];
  events: readonly PersistedChatEvent[];
}): void {
  const reportedCompletedRunIds = new Set(
    completedRunIdsFromEvents(persistentEvents),
  );
  const newlyCompletedRunIds = completedRunIdsFromEvents(events).filter(
    (runId) => {
      return !reportedCompletedRunIds.has(runId);
    },
  );
  for (const _ of newlyCompletedRunIds) {
    captureTaskCompletedSuccessfully();
  }
}

function mergePersistentEvents(
  eventSets: readonly (readonly PersistedChatEvent[])[],
): PersistedChatEvent[] {
  const byId = new Map<string, PersistedChatEvent>();
  for (const events of eventSets) {
    for (const event of events) {
      byId.set(event.id, event);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    return left.seqId - right.seqId;
  });
}

function createStoredChatEventsComputed({
  persistentEvents$,
  optimisticEvents$,
}: {
  persistentEvents$: PersistentChatEvents$;
  optimisticEvents$: Computed<OptimisticChatEventEntry[]>;
}): Computed<ChatEvent[]> {
  return computed((get): ChatEvent[] => {
    const persistentEvents = get(persistentEvents$);
    const serverIds = new Set(
      persistentEvents.map((event) => {
        return event.id;
      }),
    );
    const optimisticEvents = get(optimisticEvents$).filter((entry) => {
      return !serverIds.has(entry.event.id);
    });
    return [
      ...persistentEvents,
      ...optimisticEvents.map((entry) => {
        const association = entry.optimisticUserMessageAssociation;
        return association === undefined
          ? entry.event
          : {
              ...entry.event,
              optimisticUserMessageAssociation: association,
            };
      }),
    ];
  });
}

interface RowSyncDependencies {
  readonly threadId: string;
  readonly persistentEvents$: PersistentChatEvents$;
  readonly mergePersistentEvents$: Command<
    Promise<void>,
    [PersistedChatEvent[], AbortSignal]
  >;
}

/**
 * Snapshot-backed canonical-row pipeline: the raw-row cache is the source of
 * truth and rows project into ChatEvents only at this merge boundary. Cold
 * start downloads the full-thread archive object; afterwards the /event-rows
 * tail keeps the cache current, and a 410 (cursor reclaimed) rebuilds from a
 * fresh snapshot.
 */
function createSyncRemoteRowsCommand({
  threadId,
  persistentEvents$,
  mergePersistentEvents$,
}: RowSyncDependencies): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const mergeRows = async (
      rows: readonly ChatEventRowV4[],
    ): Promise<void> => {
      if (rows.length === 0) {
        return;
      }
      await set(
        mergePersistentEvents$,
        rows.map((row) => {
          return chatEventFromRow(row);
        }),
        signal,
      );
      signal.throwIfAborted();
    };

    /**
     * Derive the cold-start cursor from the server. A thread the archiver has
     * not reached yet has no snapshot, so the whole thread is still in
     * Postgres and the tail below reads it from the beginning.
     */
    const loadColdStartCursor = async (): Promise<number> => {
      const snapshot = await settle(
        set(fetchChatEventSnapshotRows$, threadId, signal),
        signal,
      );
      if (!snapshot.ok) {
        throw snapshot.error;
      }
      if (snapshot.value === null) {
        return THREAD_START_SEQ_ID;
      }
      await set(writeIndexedDbChatEventRows$, snapshot.value.rows, signal);
      signal.throwIfAborted();
      await mergeRows(snapshot.value.rows);
      return snapshot.value.lastSeqId;
    };

    // True once the cursor came from the server rather than the local cache.
    // An expiry after that means the thread cannot be read at all, so the pass
    // fails loudly instead of rebuilding the same cursor forever.
    let cursorFromServer = false;
    // A cold start can race with realtime subscription setup: an event may be
    // inserted after the first tail response is assembled but before the
    // subscription is live. Confirm the server-derived cursor once more after
    // that first response so the event is not stranded in the gap.
    let needsColdStartTailConfirmation = false;
    let sinceSeqId: number;
    const cachedLastSeqId = get(persistentEvents$).at(-1)?.seqId;
    if (cachedLastSeqId === undefined) {
      sinceSeqId = await loadColdStartCursor();
      signal.throwIfAborted();
      cursorFromServer = true;
      needsColdStartTailConfirmation = true;
    } else {
      sinceSeqId = cachedLastSeqId;
    }

    let shouldLoadNextPage = true;
    while (shouldLoadNextPage) {
      const page = await set(listRowsAfter$, { threadId, sinceSeqId }, signal);
      signal.throwIfAborted();
      if (page.kind === "expired") {
        if (cursorFromServer) {
          throw new Error(
            "chat event rows cursor expired right after a cold start",
          );
        }
        await set(clearIndexedDbChatEventRows$, threadId, signal);
        signal.throwIfAborted();
        sinceSeqId = await loadColdStartCursor();
        signal.throwIfAborted();
        cursorFromServer = true;
        needsColdStartTailConfirmation = true;
        continue;
      }
      await set(writeIndexedDbChatEventRows$, page.rows, signal);
      signal.throwIfAborted();
      await mergeRows(page.rows);
      signal.throwIfAborted();
      const lastRow = page.rows.at(-1);
      if (lastRow !== undefined) {
        sinceSeqId = lastRow.seqId;
      }
      const confirmColdStartTail = needsColdStartTailConfirmation;
      needsColdStartTailConfirmation = false;
      shouldLoadNextPage =
        confirmColdStartTail || page.rows.length === CHAT_EVENT_ROWS_PAGE_LIMIT;
    }
  });
}

function createRowCacheSignals(
  threadId: string,
  persistentEvents$: PersistentChatEvents$,
) {
  const loadRowCacheIntoPersistentEvents$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const rows = await set(
        loadIndexedDbChatEventRowsAfter$,
        threadId,
        null,
        signal,
      );
      signal.throwIfAborted();
      if (rows.length === 0) {
        return;
      }
      set(persistentEvents$, (previous) => {
        return mergePersistentEvents([
          previous,
          rows.map((row) => {
            return chatEventFromRow(row);
          }),
        ]);
      });
    },
  );

  return { loadRowCacheIntoPersistentEvents$ };
}

export function createChatEventStorageSignals({
  threadId,
}: {
  threadId: string;
}) {
  const persistentChatEvents$ = state<PersistedChatEvent[]>([]);
  const optimisticEvents$ = createOptimisticChatEventsForThread(threadId);
  const hasOptimisticUserMessage$ = computed((get): boolean => {
    return get(optimisticEvents$).some((entry) => {
      return entry.optimisticUserMessageAssociation !== undefined;
    });
  });
  const chatEvents$ = createStoredChatEventsComputed({
    persistentEvents$: persistentChatEvents$,
    optimisticEvents$,
  });
  const appendOptimisticEvent$: AppendOptimisticEventCommand = command(
    async (
      { set },
      input: OptimisticChatEventInput,
      signal: AbortSignal,
    ): Promise<void> => {
      set(appendOptimisticChatEvent$, createOptimisticChatEventEntry(input));
      await set(notifyChatEventsChanged$, chatEvents$, signal);
      signal.throwIfAborted();
    },
  );
  const mergePersistentEvents$ = command(
    async (
      { get, set },
      events: PersistedChatEvent[],
      signal: AbortSignal,
    ): Promise<void> => {
      if (events.length === 0) {
        return;
      }
      reportNewCompletedRuns({
        persistentEvents: get(persistentChatEvents$),
        events,
      });
      set(persistentChatEvents$, (previous) => {
        return mergePersistentEvents([previous, events]);
      });
      set(reconcileOptimisticChatEvents$, { threadId, events });
      await set(notifyChatEventsChanged$, chatEvents$, signal);
      signal.throwIfAborted();
    },
  );
  const syncRemoteEvents$ = createSyncRemoteRowsCommand({
    threadId,
    persistentEvents$: persistentChatEvents$,
    mergePersistentEvents$,
  });
  const rowCache = createRowCacheSignals(threadId, persistentChatEvents$);
  const initializeIndexedDbEvents$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const result = await settle(
        set(rowCache.loadRowCacheIntoPersistentEvents$, signal),
        signal,
      );
      if (!result.ok) {
        throw result.error;
      }
      if (get(chatEvents$).length > 0) {
        await set(notifyChatEventsChanged$, chatEvents$, signal);
        signal.throwIfAborted();
      }
    },
  );

  return {
    chatEvents$,
    hasOptimisticUserMessage$,
    initializeIndexedDbEvents$,
    mergePersistentEvents$,
    appendOptimisticEvent$,
    syncRemoteEvents$,
  };
}
