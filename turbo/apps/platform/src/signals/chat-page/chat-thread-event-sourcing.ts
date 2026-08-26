import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { accept } from "../../lib/accept.ts";
import { activeRoute$ } from "../active-route.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { apiClient$ } from "../api-client.ts";
import { foregroundReady$ } from "../auth-retry.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { createIdbChatThreadEventStores } from "../external/idb-chat-thread-event-store.ts";
import { chatIdb$ } from "../external/chat-idb-store.ts";
import { logger } from "../log.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import { pathParams$ } from "../route.ts";
import { bestEffort, createDeferredPromise } from "../utils.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  ChatThreadEventDataKey,
  ChatThreadEventQueryResult,
} from "../../shared-database/data-key.ts";
import { CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD } from "../../shared-database/event-log-policy.ts";
import {
  onSharedDatabase$,
  queryChatThreadEventSharedDatabase$,
} from "../shared-database.ts";
import { sharedDatabaseModeEnabled$ } from "../shared-database-mode.ts";
import { enqueueSharedDatabaseInvalidation$ } from "../shared-database-invalidation-queue.ts";
import type {
  ChatThreadEventView,
  OptimisticChatThreadEvent,
} from "./chat-thread-event-types.ts";

const L = logger("ChatThreadEventSourcing");

type Stores = ReturnType<typeof createIdbChatThreadEventStores>;
type ChatThreadsClient = InitClientReturn<ChatThreadsContract, InitClientArgs>;
type ChatThreadEventSyncMode = "incremental" | "snapshot-rebase";

interface ChatThreadEventData {
  readonly snapshot: readonly ChatThreadSnapshotProjection[];
  readonly events: readonly ChatThreadEvent[];
}

interface ChatThreadSnapshotData {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

interface ChatThreadEventState {
  readonly snapshot: ChatThreadSnapshotData | null;
  readonly events: readonly ChatThreadEvent[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

interface ChatThreadEventUpdate {
  readonly state: ChatThreadEventState;
  readonly replacementSnapshot: ChatThreadSnapshotData | null;
  readonly newEvents: readonly ChatThreadEvent[];
}

interface ChatThreadEventCursor {
  readonly eventId: string;
  readonly seqId: number;
}

interface ChatThreadEventSyncResult {
  readonly eventCount: number;
  readonly snapshotReplaced: boolean;
}

export interface ThreadMeta {
  readonly id: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly pinnedAt: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: "priority" | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: string | null;
}

interface ThreadMetaResolution {
  readonly localDurationMs?: number;
  readonly meta: ThreadMeta | null;
  readonly remoteDurationMs?: number;
  readonly source: "local" | "memory" | "not_found" | "remote";
}

const optimisticChatThreadEventsState$ = state<
  readonly OptimisticChatThreadEvent[]
>([]);
const chatThreadEventState$ = state<ChatThreadEventState>({
  snapshot: null,
  events: [],
  latestEventId: null,
  latestSeqId: null,
});

const initialLocalChatThreadEventsLoadedDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

const initialRemoteChatThreadEventsSyncedDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

const initialLocalChatThreadEventsLoaded$ = computed((get) => {
  return get(initialLocalChatThreadEventsLoadedDeferred$).promise;
});

const initialRemoteChatThreadEventsSynced$ = computed((get) => {
  return get(initialRemoteChatThreadEventsSyncedDeferred$).promise;
});

interface ChatThreadEventSyncBarrier {
  inFlight: boolean;
  next: ReturnType<typeof createDeferredPromise<void>>;
}

const chatThreadEventSyncBarrier$ = computed(
  (get): ChatThreadEventSyncBarrier => {
    return {
      inFlight: false,
      next: createDeferredPromise<void>(get(rootSignal$)),
    };
  },
);

const markChatThreadEventSyncPending$ = command(({ get }) => {
  get(chatThreadEventSyncBarrier$).inFlight = true;
});

const resolveNextChatThreadEventSync$ = command(({ get }) => {
  const barrier = get(chatThreadEventSyncBarrier$);
  const completed = barrier.next;
  barrier.inFlight = false;
  barrier.next = createDeferredPromise<void>(get(rootSignal$));
  if (!completed.settled()) {
    completed.resolve();
  }
});

const optimisticChatThreadCreateIds$ = computed((get): ReadonlySet<string> => {
  return new Set(
    get(optimisticChatThreadEventsState$).flatMap((event) => {
      return event.kind === "created" ? [event.chatThreadId] : [];
    }),
  );
});

function filterUnsettledOptimisticChatThreadEvents(
  optimistic: readonly OptimisticChatThreadEvent[],
  persisted: ChatThreadEventData,
): OptimisticChatThreadEvent[] {
  if (optimistic.length === 0) {
    return [];
  }
  const persistedEventIds = new Set(
    persisted.events.map((event) => {
      return event.id;
    }),
  );
  return optimistic.filter((event) => {
    return !persistedEventIds.has(event.id);
  });
}

async function readChatThreadEventState(
  store: Stores,
  signal?: AbortSignal,
): Promise<ChatThreadEventState> {
  const [snapshot, eventLog] = await Promise.all([
    store.readStore.readSnapshot(signal),
    store.readStore.readEventLog(signal),
  ]);
  return {
    snapshot,
    events: eventLog.events,
    latestEventId: eventLog.latestEventId ?? snapshot?.latestEventId ?? null,
    latestSeqId: eventLog.latestSeqId ?? snapshot?.latestSeqId ?? null,
  };
}

const chatThreadEventStores$ = computed((get): Stores => {
  const dbPromise = get(chatIdb$);
  return createIdbChatThreadEventStores(() => {
    return dbPromise;
  });
});

const lastEventCursor$ = computed((get): ChatThreadEventCursor | null => {
  const state = get(chatThreadEventState$);
  if (state.latestEventId === null || state.latestSeqId === null) {
    return null;
  }
  return {
    eventId: state.latestEventId,
    seqId: state.latestSeqId,
  };
});

function snapshotCursor(
  snapshot: ChatThreadSnapshotData,
): ChatThreadEventCursor | null {
  return snapshot.latestEventId === null || snapshot.latestSeqId === null
    ? null
    : {
        eventId: snapshot.latestEventId,
        seqId: snapshot.latestSeqId,
      };
}

function eventCursor(event: ChatThreadEvent): ChatThreadEventCursor {
  return {
    eventId: event.id,
    seqId: event.seqId,
  };
}

async function fetchRemoteSnapshot(
  client: ChatThreadsClient,
  mode: ChatThreadEventSyncMode,
  signal?: AbortSignal,
): Promise<ChatThreadSnapshotData> {
  const result = await accept(
    client.snapshot({ fetchOptions: { signal } }),
    [200],
    signal,
    { showErrorToast: mode !== "snapshot-rebase" },
  );
  signal?.throwIfAborted();
  return {
    chatThreads: result.body.chatThreads,
    latestEventId: result.body.latestEventId,
    latestSeqId: result.body.latestSeqId,
  };
}

async function fetchRemoteEvents(
  client: ChatThreadsClient,
  cursor: ChatThreadEventCursor | null,
  mode: ChatThreadEventSyncMode,
  signal?: AbortSignal,
) {
  const request = client.events({
    query: cursor ? { sinceSeqId: cursor.seqId } : {},
    fetchOptions: { signal },
  });
  return await accept(request, [200, 410], signal, {
    showErrorToast: mode !== "snapshot-rebase",
  });
}

function createChatThreadEventUpdate(
  snapshot: ChatThreadSnapshotData,
  events: readonly ChatThreadEvent[],
  cursor: ChatThreadEventCursor | null,
  snapshotReplaced: boolean,
  newEvents: readonly ChatThreadEvent[],
): ChatThreadEventUpdate | null {
  if (!snapshotReplaced && newEvents.length === 0) {
    return null;
  }
  return {
    state: {
      snapshot,
      events,
      latestEventId: cursor?.eventId ?? null,
      latestSeqId: cursor?.seqId ?? null,
    },
    replacementSnapshot: snapshotReplaced ? snapshot : null,
    newEvents,
  };
}

async function fetchChatThreadEventUpdate(
  currentState: ChatThreadEventState,
  initialCursor: ChatThreadEventCursor | null,
  client: ChatThreadsClient,
  mode: ChatThreadEventSyncMode,
  signal?: AbortSignal,
): Promise<ChatThreadEventUpdate | null> {
  let snapshot = currentState.snapshot;
  let events = currentState.events;
  let cursor = initialCursor;
  let snapshotReplaced = false;
  let newEvents: readonly ChatThreadEvent[] = [];

  if (mode === "snapshot-rebase" || !snapshot || cursor === null) {
    snapshot = await fetchRemoteSnapshot(client, mode, signal);
    events = [];
    cursor = snapshotCursor(snapshot);
    snapshotReplaced = true;
  }

  for (let page = 0; page < 20; page++) {
    const result = await fetchRemoteEvents(client, cursor, mode, signal);
    signal?.throwIfAborted();

    if (result.status === 410) {
      L.debug("events cursor expired, reloading snapshot");
      snapshot = await fetchRemoteSnapshot(client, mode, signal);
      events = [];
      newEvents = [];
      cursor = snapshotCursor(snapshot);
      snapshotReplaced = true;
      continue;
    }

    const pageEvents: readonly ChatThreadEvent[] = result.body.events;
    if (pageEvents.length > 0) {
      events = [...events, ...pageEvents];
      newEvents = [...newEvents, ...pageEvents];
      cursor = eventCursor(pageEvents[pageEvents.length - 1]!);
    }

    if (!result.body.hasMore || result.body.events.length === 0) {
      return createChatThreadEventUpdate(
        snapshot,
        events,
        cursor,
        snapshotReplaced,
        newEvents,
      );
    }
  }
  return createChatThreadEventUpdate(
    snapshot,
    events,
    cursor,
    snapshotReplaced,
    newEvents,
  );
}

const initializeChatThreadEventState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const store = get(chatThreadEventStores$);
    const state = await readChatThreadEventState(store, signal);
    signal.throwIfAborted();
    set(chatThreadEventState$, state);
    set(reconcileOptimisticChatThreadEvents$, {
      snapshot: state.snapshot?.chatThreads ?? [],
      events: state.events,
    });
    set(syncCurrentChatThreadDocumentTitle$, signal);
    const loaded = get(initialLocalChatThreadEventsLoadedDeferred$);
    if (!loaded.settled()) {
      loaded.resolve();
    }
  },
);

const syncChatThreadEvents$ = command(
  async (
    { get, set },
    mode: ChatThreadEventSyncMode,
    signal: AbortSignal,
  ): Promise<ChatThreadEventSyncResult> => {
    if (mode === "incremental") {
      set(markChatThreadEventSyncPending$);
    }
    const store = get(chatThreadEventStores$);
    const state = get(chatThreadEventState$);
    const client = get(apiClient$)(chatThreadsContract);
    const update = await fetchChatThreadEventUpdate(
      state,
      get(lastEventCursor$),
      client,
      mode,
      signal,
    );
    signal.throwIfAborted();
    let result: ChatThreadEventSyncResult;
    if (!update) {
      result = {
        eventCount: state.events.length,
        snapshotReplaced: false,
      };
    } else {
      const persistableNewEvents = update.newEvents;
      if (update.replacementSnapshot) {
        await store.writeStore.replaceFromSnapshot(
          update.replacementSnapshot,
          persistableNewEvents,
          signal,
        );
      } else {
        await store.writeStore.upsertEvents(persistableNewEvents, signal);
      }
      signal.throwIfAborted();
      set(chatThreadEventState$, update.state);
      set(reconcileOptimisticChatThreadEvents$, {
        snapshot: update.state.snapshot?.chatThreads ?? [],
        events: update.state.events,
      });
      set(syncCurrentChatThreadDocumentTitle$, signal);
      result = {
        eventCount: update.state.events.length,
        snapshotReplaced: update.replacementSnapshot !== null,
      };
    }

    if (mode === "incremental") {
      const synced = get(initialRemoteChatThreadEventsSyncedDeferred$);
      if (!synced.settled()) {
        synced.resolve();
      }
      set(resolveNextChatThreadEventSync$);
    }
    return result;
  },
);

const syncLegacyEventDrivenChatThreads$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(syncChatThreadEvents$, "incremental", signal);
  },
);

const subscribeLegacyEventDrivenChatThreads$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    let initialSnapshotRebasePending = true;
    const syncOnThreadListChanged$ = command(
      async ({ set }, signal: AbortSignal): Promise<boolean> => {
        const result = await set(syncChatThreadEvents$, "incremental", signal);
        if (initialSnapshotRebasePending) {
          initialSnapshotRebasePending = false;
          if (
            !result.snapshotReplaced &&
            result.eventCount > CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD
          ) {
            await bestEffort(
              set(syncChatThreadEvents$, "snapshot-rebase", signal),
              signal,
            );
          }
        }
        return false;
      },
    );

    await set(initializeChatThreadEventState$, signal);
    signal.throwIfAborted();
    await set(
      setAblyLoop$,
      {
        topic: "threadListChanged",
        loopCommand$: syncOnThreadListChanged$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

const sharedChatThreadEventDataKey$ = computed(
  async (get): Promise<ChatThreadEventDataKey> => {
    const { userId, orgId } = await get(authenticatedIdentity$);
    return { kind: "chat-thread-event", userId, orgId };
  },
);

const applySharedChatThreadEventResult$ = command(
  (
    { get, set },
    result: ChatThreadEventQueryResult,
    phase: "local" | "remote",
    signal: AbortSignal,
  ): void => {
    const lastEvent = result.events.at(-1);
    const state: ChatThreadEventState = {
      snapshot:
        result.snapshot === null
          ? null
          : {
              chatThreads: result.snapshot.chatThreads,
              latestEventId: result.snapshot.latestEventId,
              latestSeqId: result.snapshot.latestSeqId,
            },
      events: result.events,
      latestEventId: lastEvent?.id ?? result.snapshot?.latestEventId ?? null,
      latestSeqId: lastEvent?.seqId ?? result.snapshot?.latestSeqId ?? null,
    };
    set(chatThreadEventState$, state);
    set(reconcileOptimisticChatThreadEvents$, {
      snapshot: state.snapshot?.chatThreads ?? [],
      events: state.events,
    });
    set(syncCurrentChatThreadDocumentTitle$, signal);
    if (phase === "local") {
      const loaded = get(initialLocalChatThreadEventsLoadedDeferred$);
      if (!loaded.settled()) {
        loaded.resolve();
      }
      return;
    }
    const synced = get(initialRemoteChatThreadEventsSyncedDeferred$);
    if (!synced.settled()) {
      synced.resolve();
    }
    set(resolveNextChatThreadEventSync$);
  },
);

const syncSharedEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(markChatThreadEventSyncPending$);
    const dataKey = await get(sharedChatThreadEventDataKey$);
    signal.throwIfAborted();
    const currentSeqId = get(chatThreadEventState$).latestSeqId;
    const cached = await set(
      queryChatThreadEventSharedDatabase$,
      {
        dataKey,
        afterSeqId: currentSeqId,
        consistency: "cache-only",
      },
      signal,
    );
    signal.throwIfAborted();
    const cachedLastSeqId =
      cached.events.at(-1)?.seqId ?? cached.snapshot?.latestSeqId ?? null;
    const result =
      cachedLastSeqId !== null &&
      (currentSeqId === null || cachedLastSeqId > currentSeqId)
        ? cached
        : await set(
            queryChatThreadEventSharedDatabase$,
            {
              dataKey,
              afterSeqId: currentSeqId,
              consistency: "catch-up",
            },
            signal,
          );
    signal.throwIfAborted();
    set(applySharedChatThreadEventResult$, result, "remote", signal);
  },
);

const subscribeSharedEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const dataKey = await get(sharedChatThreadEventDataKey$);
    signal.throwIfAborted();
    await set(
      onSharedDatabase$,
      dataKey,
      () => {
        set(enqueueSharedDatabaseInvalidation$, dataKey);
      },
      signal,
    );
    signal.throwIfAborted();
    const cached = await set(
      queryChatThreadEventSharedDatabase$,
      { dataKey, afterSeqId: null, consistency: "cache-only" },
      signal,
    );
    signal.throwIfAborted();
    set(applySharedChatThreadEventResult$, cached, "local", signal);
    await set(syncSharedEventDrivenChatThreads$, signal);
  },
);

export const syncEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await set(
      get(sharedDatabaseModeEnabled$)
        ? syncSharedEventDrivenChatThreads$
        : syncLegacyEventDrivenChatThreads$,
      signal,
    );
  },
);

export const subscribeEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await set(
      get(sharedDatabaseModeEnabled$)
        ? subscribeSharedEventDrivenChatThreads$
        : subscribeLegacyEventDrivenChatThreads$,
      signal,
    );
  },
);

const chatThreadsSnapshot$ = computed((get) => {
  return get(chatThreadEventState$).snapshot?.chatThreads ?? [];
});

const allChatThreadsEvents$ = computed((get) => {
  const state = get(chatThreadEventState$);
  const persistedData: ChatThreadEventData = {
    snapshot: state.snapshot?.chatThreads ?? [],
    events: state.events,
  };
  const persisted = persistedData.events;
  const optimistic = filterUnsettledOptimisticChatThreadEvents(
    get(optimisticChatThreadEventsState$),
    persistedData,
  );
  return [...persisted, ...optimistic] satisfies ChatThreadEventView[];
});

export const eventDrivenChatThreads$ = computed((get) => {
  return replayChatThreadEvents(
    get(chatThreadsSnapshot$),
    get(allChatThreadsEvents$),
  );
});

const eventDrivenChatThreadMap$ = computed((get) => {
  return new Map(
    get(eventDrivenChatThreads$).map((thread) => {
      return [thread.id, thread] as const;
    }),
  );
});

export function eventDrivenChatThread(threadId: string) {
  return computed((get) => {
    return get(eventDrivenChatThreadMap$).get(threadId) ?? null;
  });
}

export function optimisticChatThreadCreateUnsettled(threadId: string) {
  return computed((get): boolean => {
    return get(optimisticChatThreadCreateIds$).has(threadId);
  });
}

export const chatThreadMetaMap$ = computed((get) => {
  return new Map<string, ThreadMeta>(
    get(eventDrivenChatThreads$).map((thread) => {
      return [
        thread.id,
        {
          id: thread.id,
          agentId: thread.agentId,
          title: thread.title,
          pinnedAt: thread.pinnedAt,
          selectedModel: thread.selectedModel,
          serviceTier: thread.serviceTier,
          computerUseHostId: thread.computerUseHostId,
          cloudBrowserEnabled: thread.cloudBrowserEnabled,
          selectedVideoModel: thread.selectedVideoModel,
          selectedImageModel: thread.selectedImageModel,
        },
      ];
    }),
  );
});

export function threadMeta(threadId: string) {
  return computed((get): ThreadMeta | null => {
    return get(chatThreadMetaMap$).get(threadId) ?? null;
  });
}

export function resolvedThreadMeta(threadId: string) {
  const meta$ = threadMeta(threadId);
  return computed(async (get): Promise<ThreadMetaResolution> => {
    let meta = get(meta$);
    if (meta) {
      return { meta, source: "memory" };
    }

    const localStartedAt = performance.now();
    const foregroundReady = get(foregroundReady$);
    const syncBarrier = get(chatThreadEventSyncBarrier$);
    const foregroundSync =
      foregroundReady.pending || syncBarrier.inFlight
        ? syncBarrier.next.promise
        : null;

    await get(initialLocalChatThreadEventsLoaded$);
    const localDurationMs = Math.round(performance.now() - localStartedAt);
    meta = get(meta$);
    if (meta) {
      return { localDurationMs, meta, source: "local" };
    }

    const remoteStartedAt = performance.now();
    if (foregroundSync) {
      await foregroundReady.promise;
      await foregroundSync;
      meta = get(meta$);
      if (meta) {
        return {
          localDurationMs,
          meta,
          remoteDurationMs: Math.round(performance.now() - remoteStartedAt),
          source: "remote",
        };
      }
    }

    await get(initialRemoteChatThreadEventsSynced$);
    meta = get(meta$);
    return {
      localDurationMs,
      meta,
      remoteDurationMs: Math.round(performance.now() - remoteStartedAt),
      source: meta ? "remote" : "not_found",
    };
  });
}

/** Synchronize the active primary chat tab title after committed thread data changes. */
const syncCurrentChatThreadDocumentTitle$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (get(activeRoute$) !== "chat") {
      return;
    }
    const threadId = get(pathParams$)?.threadId;
    if (typeof threadId !== "string") {
      return;
    }
    const meta = get(threadMeta(threadId));
    signal.throwIfAborted();
    if (meta) {
      set(
        updateDocumentTitle$,
        meta.title ??
          i18n.t(($) => {
            return $.chat.newChat;
          }),
      );
    }
  },
);

export const registerOptimisticChatThreadEvent$ = command(
  ({ set }, event: OptimisticChatThreadEvent) => {
    set(optimisticChatThreadEventsState$, (events) => {
      if (
        events.some((existing) => {
          return existing.id === event.id;
        })
      ) {
        return events;
      }
      return [...events, event];
    });
  },
);

export const touchOptimisticChatThreadSort$ = command(
  (
    { set },
    args: {
      readonly id: string;
      readonly threadId: string;
      readonly agentId: string;
      readonly createdAt: string;
    },
  ) => {
    set(registerOptimisticChatThreadEvent$, {
      id: args.id,
      kind: "sort_touched",
      chatThreadId: args.threadId,
      agentId: args.agentId,
      title: null,
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      selectedVideoModel: null,
      selectedImageModel: null,
      createdAt: args.createdAt,
    } satisfies OptimisticChatThreadEvent);
  },
);

export const reconcileOptimisticChatThreadEvents$ = command(
  ({ set }, persisted: ChatThreadEventData) => {
    set(optimisticChatThreadEventsState$, (events) => {
      return filterUnsettledOptimisticChatThreadEvents(events, persisted);
    });
  },
);
