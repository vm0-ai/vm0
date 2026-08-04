import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type { ChatEvent as PersistedChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { captureTaskCompletedSuccessfully } from "../../lib/posthog.ts";
import { logger } from "../log.ts";
import { settle } from "../utils.ts";
import { notifyChatEventsChanged$ } from "./chat-event-change-registry.ts";
import {
  loadIndexedDbChatEvents$,
  writeIndexedDbChatEvents$,
} from "./chat-event-indexed-db.ts";
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

export type OptimisticScrollBehavior = "preserve" | "bottom";
export type AppendOptimisticEventCommand = Command<
  Promise<void>,
  [OptimisticChatEventInput, OptimisticScrollBehavior, AbortSignal]
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

export function createChatEventStorageSignals({
  threadId,
  dataSource,
}: {
  threadId: string;
  dataSource: ChatEventDataSource;
}) {
  const persistentChatEvents$ = state<PersistedChatEvent[]>([]);
  const optimisticEvents$ = createOptimisticChatEventsForThread(threadId);
  const chatEvents$ = createStoredChatEventsComputed({
    persistentEvents$: persistentChatEvents$,
    optimisticEvents$,
  });
  const appendOptimisticEvent$: AppendOptimisticEventCommand = command(
    async (
      { set },
      input: OptimisticChatEventInput,
      scrollBehavior: OptimisticScrollBehavior,
      signal: AbortSignal,
    ): Promise<void> => {
      set(appendOptimisticChatEvent$, createOptimisticChatEventEntry(input));
      await set(
        notifyChatEventsChanged$,
        chatEvents$,
        scrollBehavior === "bottom" ? "follow-tail" : "preserve",
        signal,
      );
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
      await set(notifyChatEventsChanged$, chatEvents$, "preserve", signal);
      signal.throwIfAborted();
    },
  );
  const hasReachedOldestEvent$ = computed((get): boolean => {
    return get(persistentChatEvents$)[0]?.seqId === FIRST_CHAT_EVENT_SEQ_ID;
  });
  const initialRemoteEventsResolved$ = state(false);
  const syncRemoteEvents$ = createSyncRemoteEventsCommand({
    threadId,
    persistentEvents$: persistentChatEvents$,
    hasReachedOldestEvent$,
    initialRemoteEventsResolved$,
    mergePersistentEvents$,
    dataSource,
  });
  const initializeIndexedDbEvents$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const result = await settle(
        set(
          indexedDbEventCache.loadIndexedDbEventsIntoPersistentEvents$,
          signal,
        ),
        signal,
      );
      await set(notifyChatEventsChanged$, chatEvents$, "initialize", signal);
      signal.throwIfAborted();
      if (!result.ok) {
        throw result.error;
      }
    },
  );

  return {
    chatEvents$,
    initialRemoteEventsResolved$,
    initializeIndexedDbEvents$,
    mergePersistentEvents$,
    appendOptimisticEvent$,
    syncRemoteEvents$,
  };
}
