import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import type { ChatEvent as PersistedChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { captureTaskCompletedSuccessfully } from "../../lib/posthog.ts";
import { settle } from "../utils.ts";
import { syncGoogleAdsConversionMilestones$ } from "../bootstrap/google-ads-conversion-milestones.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import type { ChatEventDataKey } from "../../shared-database/data-key.ts";
import {
  onSharedDatabase$,
  queryChatEventSharedDatabase$,
} from "../shared-database.ts";
import { sharedDatabaseModeEnabled$ } from "../shared-database-mode.ts";
import { enqueueSharedDatabaseInvalidation$ } from "../shared-database-invalidation-queue.ts";
import { notifyChatEventsChanged$ } from "./chat-event-change-registry.ts";
import {
  clearIndexedDbChatEventRows$,
  loadIndexedDbChatEventCursor$,
  loadIndexedDbChatEventRowsAfter$,
  replaceIndexedDbChatEventRows$,
  writeIndexedDbChatEventRows$,
} from "./chat-event-row-indexed-db.ts";
import {
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
}): boolean {
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
  return newlyCompletedRunIds.length > 0;
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
  mergePersistentEvents$,
}: RowSyncDependencies): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ set }, signal: AbortSignal): Promise<void> => {
    const mergeRows = async (rows: readonly ChatEventRow[]): Promise<void> => {
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
    const loadColdStartCursor = async (): Promise<{
      readonly cursor: ChatEventCursor;
    }> => {
      const result = await settle(
        set(fetchChatEventSnapshotRows$, threadId, signal),
        signal,
      );
      if (!result.ok) {
        throw result.error;
      }
      const snapshot = result.value.snapshot;
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
      signal.throwIfAborted();
      await mergeRows(snapshot?.rows ?? []);
      return { cursor };
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
    let cursor: ChatEventCursor;
    const cachedCursor = await set(
      loadIndexedDbChatEventCursor$,
      threadId,
      signal,
    );
    if (cachedCursor === null) {
      const coldStart = await loadColdStartCursor();
      signal.throwIfAborted();
      cursor = coldStart.cursor;
      cursorFromServer = true;
      needsColdStartTailConfirmation = true;
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
            "chat event rows cursor expired right after a cold start",
          );
        }
        await set(clearIndexedDbChatEventRows$, threadId, signal);
        signal.throwIfAborted();
        const coldStart = await loadColdStartCursor();
        signal.throwIfAborted();
        cursor = coldStart.cursor;
        cursorFromServer = true;
        needsColdStartTailConfirmation = true;
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
      signal.throwIfAborted();
      await mergeRows(page.rows);
      signal.throwIfAborted();
      const confirmColdStartTail = needsColdStartTailConfirmation;
      needsColdStartTailConfirmation = false;
      shouldLoadNextPage = confirmColdStartTail || page.hasMore;
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

function createSharedDatabaseEventSignals({
  threadId,
  persistentChatEvents$,
  chatEvents$,
  mergePersistentEvents$,
}: {
  readonly threadId: string;
  readonly persistentChatEvents$: PersistentChatEvents$;
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly mergePersistentEvents$: Command<
    Promise<void>,
    [PersistedChatEvent[], AbortSignal]
  >;
}) {
  const dataKey$ = computed(async (get): Promise<ChatEventDataKey> => {
    const { userId, orgId } = await get(authenticatedIdentity$);
    return { kind: "chat-event", userId, orgId, threadId };
  });
  const load$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const dataKey = await get(dataKey$);
      signal.throwIfAborted();
      const rows = await set(
        queryChatEventSharedDatabase$,
        { dataKey, afterSeqId: null, consistency: "cache-only" },
        signal,
      );
      signal.throwIfAborted();
      if (rows.length === 0) {
        return;
      }
      const events = rows.map((row) => {
        return chatEventFromRow(row);
      });
      set(persistentChatEvents$, (previous) => {
        return mergePersistentEvents([previous, events]);
      });
      set(reconcileOptimisticChatEvents$, { threadId, events });
      await set(notifyChatEventsChanged$, chatEvents$, signal);
    },
  );
  const sync$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const dataKey = await get(dataKey$);
      signal.throwIfAborted();
      const afterSeqId = get(persistentChatEvents$).at(-1)?.seqId ?? null;
      const cachedRows = await set(
        queryChatEventSharedDatabase$,
        { dataKey, afterSeqId, consistency: "cache-only" },
        signal,
      );
      signal.throwIfAborted();
      const rows =
        cachedRows.length > 0
          ? cachedRows
          : await set(
              queryChatEventSharedDatabase$,
              { dataKey, afterSeqId, consistency: "catch-up" },
              signal,
            );
      signal.throwIfAborted();
      await set(
        mergePersistentEvents$,
        rows.map((row) => {
          return chatEventFromRow(row);
        }),
        signal,
      );
    },
  );
  const subscribe$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const dataKey = await get(dataKey$);
      signal.throwIfAborted();
      await set(
        onSharedDatabase$,
        dataKey,
        () => {
          set(enqueueSharedDatabaseInvalidation$, dataKey);
        },
        signal,
      );
    },
  );
  return { load$, subscribe$, sync$ };
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
      const hasNewCompletedRun = reportNewCompletedRuns({
        persistentEvents: get(persistentChatEvents$),
        events,
      });
      set(persistentChatEvents$, (previous) => {
        return mergePersistentEvents([previous, events]);
      });
      set(reconcileOptimisticChatEvents$, { threadId, events });
      await set(notifyChatEventsChanged$, chatEvents$, signal);
      signal.throwIfAborted();
      if (hasNewCompletedRun) {
        await settle(set(syncGoogleAdsConversionMilestones$, signal), signal);
      }
    },
  );
  const syncLegacyRemoteEvents$ = createSyncRemoteRowsCommand({
    threadId,
    mergePersistentEvents$,
  });
  const sharedDatabase = createSharedDatabaseEventSignals({
    threadId,
    persistentChatEvents$,
    chatEvents$,
    mergePersistentEvents$,
  });
  const syncRemoteEvents$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      await set(
        get(sharedDatabaseModeEnabled$)
          ? sharedDatabase.sync$
          : syncLegacyRemoteEvents$,
        signal,
      );
    },
  );
  const rowCache = createRowCacheSignals(threadId, persistentChatEvents$);
  const initializeIndexedDbEvents$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (get(sharedDatabaseModeEnabled$)) {
        await set(sharedDatabase.subscribe$, signal);
        signal.throwIfAborted();
        await set(sharedDatabase.load$, signal);
        return;
      }
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
