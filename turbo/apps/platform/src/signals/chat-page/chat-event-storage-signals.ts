import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type { ChatEventRow } from "@vm0/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@vm0/api-contracts/contracts/chat-event-row-projection";
import type { ChatEvent as PersistedChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { captureTaskCompletedSuccessfully } from "../../lib/posthog.ts";
import { chatEventSnapshotReadEnabled$ } from "../external/feature-switch.ts";
import { logger } from "../log.ts";
import { settle } from "../utils.ts";
import { notifyChatEventsChanged$ } from "./chat-event-change-registry.ts";
import {
  goalRunIdsForThread,
  recordGoalRunIds$,
} from "./chat-event-goal-run-ids.ts";
import {
  loadIndexedDbChatEvents$,
  writeIndexedDbChatEvents$,
} from "./chat-event-indexed-db.ts";
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
import {
  CHAT_EVENTS_PAGE_LIMIT,
  listEventsAfter$,
  listEventsBefore$,
} from "./remote-chat-event-data-source.ts";

const L = logger("ChatEventStorageSignals");
const HISTORY_BACKFILL_MERGE_BATCH_SIZE = 300;
const FIRST_CHAT_EVENT_SEQ_ID = 1;

export interface ChatEventDataSource {
  readonly listEventsAfter$: typeof listEventsAfter$;
  readonly listEventsBefore$: typeof listEventsBefore$;
}

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

function createIndexedDbEventCacheSignals(
  threadId: string,
  persistentEvents$: PersistentChatEvents$,
) {
  const loadIndexedDbEventsIntoPersistentEvents$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const result = await settle(
        set(loadIndexedDbChatEvents$, threadId, signal),
        signal,
      );
      if (!result.ok) {
        throw result.error;
      }
      if (result.value.length > 0) {
        set(persistentEvents$, (previous) => {
          return mergePersistentEvents([previous, result.value]);
        });
      }
      signal.throwIfAborted();
    },
  );

  return { loadIndexedDbEventsIntoPersistentEvents$ };
}

interface RemoteSyncDependencies {
  readonly threadId: string;
  readonly persistentEvents$: PersistentChatEvents$;
  readonly hasReachedOldestEvent$: Computed<boolean>;
  readonly initialRemoteEventsResolved$: State<boolean>;
  readonly mergePersistentEvents$: Command<
    Promise<void>,
    [PersistedChatEvent[], AbortSignal]
  >;
  readonly dataSource: ChatEventDataSource;
}

function createSyncRemoteEventsCommand({
  threadId,
  persistentEvents$,
  hasReachedOldestEvent$,
  initialRemoteEventsResolved$,
  mergePersistentEvents$,
  dataSource,
}: RemoteSyncDependencies): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const mergeEvents = async (events: PersistedChatEvent[]): Promise<void> => {
      await set(mergePersistentEvents$, events, signal);
      signal.throwIfAborted();
    };
    const persistentEvents = get(persistentEvents$);
    const accumulatedEvents: PersistedChatEvent[] = [];
    let mergedEventCount = 0;
    let sinceSeqId = persistentEvents.at(-1)?.seqId;
    let initialPageOldestEvent: PersistedChatEvent | undefined;

    async function syncEventsAfter(): Promise<void> {
      const requestedSinceSeqId = sinceSeqId;
      const isInitialPage = requestedSinceSeqId === undefined;
      const resolvesInitialRemoteEvents = !get(initialRemoteEventsResolved$);
      const events = await set(
        dataSource.listEventsAfter$,
        { threadId, sinceSeqId: requestedSinceSeqId },
        signal,
      );
      signal.throwIfAborted();
      if (resolvesInitialRemoteEvents) {
        set(initialRemoteEventsResolved$, true);
      }
      L.debug("sync remote events after", {
        threadId,
        sinceSeqId: requestedSinceSeqId ?? null,
        count: events.length,
      });
      if (events.length === 0) {
        return;
      }
      await set(writeIndexedDbChatEvents$, threadId, events, signal);
      signal.throwIfAborted();
      if (isInitialPage) {
        initialPageOldestEvent = events[0]!;
        await mergeEvents(events);
      } else {
        accumulatedEvents.push(...events);
      }
      sinceSeqId = events.at(-1)!.seqId;
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
    await mergeEvents(accumulatedEvents.slice(mergedEventCount));
    signal.throwIfAborted();
    mergedEventCount = accumulatedEvents.length;

    if (!get(hasReachedOldestEvent$)) {
      const oldestEvent =
        persistentEvents[0] ?? initialPageOldestEvent ?? accumulatedEvents[0];
      if (oldestEvent !== undefined) {
        let beforeSeqId = oldestEvent.seqId;
        async function syncEventsBefore(): Promise<void> {
          const events = await set(
            dataSource.listEventsBefore$,
            { threadId, beforeSeqId },
            signal,
          );
          signal.throwIfAborted();
          L.debug("sync remote events before", {
            threadId,
            beforeSeqId,
            count: events.length,
          });
          const oldestInPage = events[0];
          if (oldestInPage !== undefined) {
            accumulatedEvents.push(...events);
            await set(writeIndexedDbChatEvents$, threadId, events, signal);
            signal.throwIfAborted();
            if (
              accumulatedEvents.length - mergedEventCount >=
              HISTORY_BACKFILL_MERGE_BATCH_SIZE
            ) {
              await mergeEvents(accumulatedEvents.slice(mergedEventCount));
              signal.throwIfAborted();
              mergedEventCount = accumulatedEvents.length;
            }
          }
          if (
            oldestInPage === undefined ||
            oldestInPage.seqId <= FIRST_CHAT_EVENT_SEQ_ID
          ) {
            return;
          }
          beforeSeqId = oldestInPage.seqId;
          await syncEventsBefore();
        }
        await syncEventsBefore();
      }
    }
    signal.throwIfAborted();
    await mergeEvents(accumulatedEvents.slice(mergedEventCount));
  });
}

interface RowSyncDependencies {
  readonly threadId: string;
  readonly persistentEvents$: PersistentChatEvents$;
  readonly initialRemoteEventsResolved$: State<boolean>;
  readonly mergePersistentEvents$: Command<
    Promise<void>,
    [PersistedChatEvent[], AbortSignal]
  >;
}

/**
 * Snapshot-read pipeline: the raw-row cache is the source of truth and rows
 * project into ChatEvents only at this merge boundary. Cold start downloads
 * the full-thread archive object; afterwards the /event-rows tail keeps the
 * cache current, and a 410 (cursor reclaimed) rebuilds from a fresh snapshot.
 */
function createSyncRemoteRowsCommand({
  threadId,
  persistentEvents$,
  initialRemoteEventsResolved$,
  mergePersistentEvents$,
}: RowSyncDependencies): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const goalRunIds$ = goalRunIdsForThread(threadId);
    const mergeRows = async (rows: readonly ChatEventRow[]): Promise<void> => {
      if (rows.length === 0) {
        return;
      }
      set(recordGoalRunIds$, threadId, rows);
      const goalRunIds = get(goalRunIds$);
      await set(
        mergePersistentEvents$,
        rows.map((row) => {
          return chatEventFromRow(row, goalRunIds);
        }),
        signal,
      );
      signal.throwIfAborted();
    };

    const loadSnapshot = async (): Promise<number> => {
      const snapshot = await settle(
        set(fetchChatEventSnapshotRows$, threadId, signal),
        signal,
      );
      // The skeleton must resolve even when the snapshot is missing (404 on
      // threads the archiver has not reached); the request error surfaces
      // through the normal toast path.
      set(initialRemoteEventsResolved$, true);
      if (!snapshot.ok) {
        throw snapshot.error;
      }
      await set(writeIndexedDbChatEventRows$, snapshot.value.rows, signal);
      signal.throwIfAborted();
      await mergeRows(snapshot.value.rows);
      return snapshot.value.lastSeqId;
    };

    let rebuiltFromSnapshot = false;
    let sinceSeqId: number;
    const cachedLastSeqId = get(persistentEvents$).at(-1)?.seqId;
    if (cachedLastSeqId === undefined) {
      sinceSeqId = await loadSnapshot();
      signal.throwIfAborted();
      rebuiltFromSnapshot = true;
    } else {
      sinceSeqId = cachedLastSeqId;
    }

    for (;;) {
      const page = await set(listRowsAfter$, { threadId, sinceSeqId }, signal);
      signal.throwIfAborted();
      set(initialRemoteEventsResolved$, true);
      if (page.kind === "expired") {
        if (rebuiltFromSnapshot) {
          throw new Error(
            "chat event rows cursor expired right after a snapshot rebuild",
          );
        }
        await set(clearIndexedDbChatEventRows$, threadId, signal);
        signal.throwIfAborted();
        sinceSeqId = await loadSnapshot();
        signal.throwIfAborted();
        rebuiltFromSnapshot = true;
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
      if (page.rows.length < CHAT_EVENT_ROWS_PAGE_LIMIT) {
        return;
      }
    }
  });
}

function createRowCacheSignals(
  threadId: string,
  persistentEvents$: PersistentChatEvents$,
) {
  const loadRowCacheIntoPersistentEvents$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
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
      set(recordGoalRunIds$, threadId, rows);
      const goalRunIds = get(goalRunIdsForThread(threadId));
      set(persistentEvents$, (previous) => {
        return mergePersistentEvents([
          previous,
          rows.map((row) => {
            return chatEventFromRow(row, goalRunIds);
          }),
        ]);
      });
    },
  );

  return { loadRowCacheIntoPersistentEvents$ };
}

export function createChatEventStorageSignals({
  threadId,
  dataSource,
}: {
  threadId: string;
  dataSource: ChatEventDataSource;
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
    },
  );
  const indexedDbEventCache = createIndexedDbEventCacheSignals(
    threadId,
    persistentChatEvents$,
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
  const hasReachedOldestEvent$ = computed((get): boolean => {
    return get(persistentChatEvents$)[0]?.seqId === FIRST_CHAT_EVENT_SEQ_ID;
  });
  const initialRemoteEventsResolved$ = state(false);
  const syncLegacyRemoteEvents$ = createSyncRemoteEventsCommand({
    threadId,
    persistentEvents$: persistentChatEvents$,
    hasReachedOldestEvent$,
    initialRemoteEventsResolved$,
    mergePersistentEvents$,
    dataSource,
  });
  const syncRemoteRows$ = createSyncRemoteRowsCommand({
    threadId,
    persistentEvents$: persistentChatEvents$,
    initialRemoteEventsResolved$,
    mergePersistentEvents$,
  });
  const syncRemoteEvents$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (get(chatEventSnapshotReadEnabled$)) {
        await set(syncRemoteRows$, signal);
        return;
      }
      await set(syncLegacyRemoteEvents$, signal);
    },
  );
  const rowCache = createRowCacheSignals(threadId, persistentChatEvents$);
  const initializeIndexedDbEvents$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const result = await settle(
        get(chatEventSnapshotReadEnabled$)
          ? set(rowCache.loadRowCacheIntoPersistentEvents$, signal)
          : set(
              indexedDbEventCache.loadIndexedDbEventsIntoPersistentEvents$,
              signal,
            ),
        signal,
      );
      await set(notifyChatEventsChanged$, chatEvents$, signal);
      signal.throwIfAborted();
      if (!result.ok) {
        throw result.error;
      }
    },
  );

  return {
    chatEvents$,
    hasOptimisticUserMessage$,
    initialRemoteEventsResolved$,
    initializeIndexedDbEvents$,
    mergePersistentEvents$,
    appendOptimisticEvent$,
    syncRemoteEvents$,
  };
}
