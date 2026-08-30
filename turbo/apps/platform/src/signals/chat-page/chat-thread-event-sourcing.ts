import { command, computed, state, type Computed } from "ccstate";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
  type ChatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadMetadata,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { accept } from "../../lib/accept.ts";
import {
  captureChatThreadMetadataShortcut$,
  type ChatThreadMetadataShortcutOutcome,
} from "../../lib/posthog.ts";
import { activeRoute$ } from "../active-route.ts";
import { apiClient$ } from "../api-client.ts";
import { foregroundReady$ } from "../auth-retry.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { createIdbChatThreadEventStores } from "../external/idb-chat-thread-event-store.ts";
import { chatIdb$ } from "../external/chat-idb-store.ts";
import { logger } from "../log.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import { pathParams$ } from "../route.ts";
import {
  bestEffort,
  createChildAbortController,
  createDeferredPromise,
  settle,
  withCleanup,
} from "../utils.ts";
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

interface BootstrapThreadMetaEntry {
  readonly meta: ThreadMeta;
  readonly owner: object;
}

type ColdThreadMetaResolution =
  | { readonly source: "event-stream"; readonly meta: ThreadMeta | null }
  | { readonly source: "metadata"; readonly meta: ThreadMeta };

type RemoteThreadMetaAttempt =
  | Extract<ColdThreadMetaResolution, { readonly source: "metadata" }>
  | { readonly source: "metadata-unavailable" };

interface ResolvedThreadMeta {
  readonly localDurationMs?: number;
  readonly meta: ThreadMeta | null;
  readonly remoteDurationMs?: number;
  readonly source: "local" | "memory" | "not_found" | "remote";
}

interface RemoteThreadMetaResponse {
  readonly meta: ThreadMeta | null;
  readonly outcome: Exclude<
    ChatThreadMetadataShortcutOutcome,
    "transport-failure"
  >;
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
const bootstrapThreadMetaState$ = state<
  ReadonlyMap<string, BootstrapThreadMetaEntry>
>(new Map());
const chatThreadEventSyncVersion$ = state(0);

const clearBootstrapThreadMeta$ = command(({ get, set }) => {
  set(bootstrapThreadMetaState$, new Map());
  set(chatThreadEventSyncVersion$, get(chatThreadEventSyncVersion$) + 1);
});

const registerBootstrapThreadMeta$ = command(
  (
    { get, set },
    meta: ThreadMeta,
    syncVersion: number,
    signal: AbortSignal,
  ): boolean => {
    signal.throwIfAborted();
    if (get(chatThreadEventSyncVersion$) !== syncVersion) {
      return false;
    }
    const owner = {};
    signal.addEventListener(
      "abort",
      () => {
        const current = get(bootstrapThreadMetaState$);
        if (current.get(meta.id)?.owner !== owner) {
          return;
        }
        const remaining = new Map(current);
        remaining.delete(meta.id);
        set(bootstrapThreadMetaState$, remaining);
      },
      { once: true },
    );
    const next = new Map(get(bootstrapThreadMetaState$));
    next.set(meta.id, { meta, owner });
    set(bootstrapThreadMetaState$, next);
    return true;
  },
);

const initialLocalChatThreadEventsLoadedDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

const initialRemoteChatThreadEventsSyncedDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

const initialLocalChatThreadEventsLoaded$ = computed((get) => {
  return get(initialLocalChatThreadEventsLoadedDeferred$).promise;
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

    set(clearBootstrapThreadMeta$);

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

const sharedChatThreadEventDataKey$ = computed((): ChatThreadEventDataKey => {
  return { kind: "chat-thread-event" };
});

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
    set(clearBootstrapThreadMeta$);
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

const canonicalThreadMetaMap$ = computed((get) => {
  const metaById = new Map<string, ThreadMeta>();
  for (const thread of get(eventDrivenChatThreads$)) {
    metaById.set(thread.id, {
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
    });
  }
  return metaById;
});

export const chatThreadMetaMap$ = computed((get) => {
  const metaById = new Map<string, ThreadMeta>();
  for (const { meta } of get(bootstrapThreadMetaState$).values()) {
    metaById.set(meta.id, meta);
  }
  for (const [threadId, meta] of get(canonicalThreadMetaMap$)) {
    metaById.set(threadId, meta);
  }
  return metaById;
});

export function threadMeta(threadId: string) {
  return computed((get): ThreadMeta | null => {
    return get(chatThreadMetaMap$).get(threadId) ?? null;
  });
}

function remoteThreadMeta(metadata: ChatThreadMetadata): ThreadMeta | null {
  if (
    metadata.pinnedAt === undefined ||
    metadata.computerUseHostId === undefined ||
    metadata.cloudBrowserEnabled === undefined ||
    metadata.selectedVideoModel === undefined ||
    metadata.selectedImageModel === undefined
  ) {
    return null;
  }
  return {
    id: metadata.id,
    agentId: metadata.agentId,
    title: metadata.title,
    pinnedAt: metadata.pinnedAt,
    selectedModel: metadata.selectedModel,
    serviceTier: metadata.serviceTier,
    computerUseHostId: metadata.computerUseHostId,
    cloudBrowserEnabled: metadata.cloudBrowserEnabled,
    selectedVideoModel: metadata.selectedVideoModel,
    selectedImageModel: metadata.selectedImageModel,
  };
}

const fetchRemoteThreadMeta$ = command(
  async (
    { get },
    threadId: string,
    signal: AbortSignal,
  ): Promise<RemoteThreadMetaResponse> => {
    const client = get(apiClient$)(chatThreadMetadataContract);
    const result = await accept(
      client.get({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200, 404],
      signal,
      { showErrorToast: false },
    );
    if (result.status === 404) {
      return { meta: null, outcome: "not-found" };
    }
    const meta = remoteThreadMeta(result.body);
    return meta?.id === threadId
      ? { meta, outcome: "hit" }
      : { meta: null, outcome: "older-payload" };
  },
);

function waitForSharedWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const waitController = createChildAbortController(signal);
  const aborted = createDeferredPromise<never>(waitController.signal);
  return withCleanup(Promise.race([work, aborted.promise]), () => {
    waitController.abort(
      new DOMException("Thread metadata wait completed", "AbortError"),
    );
  });
}

const lookupEventStreamThreadMeta$ = command(
  async (
    { get },
    meta$: Computed<ThreadMeta | null>,
    sync: Promise<void>,
    signal: AbortSignal,
  ): Promise<ColdThreadMetaResolution> => {
    await waitForSharedWork(sync, signal);
    signal.throwIfAborted();
    return { source: "event-stream", meta: get(meta$) };
  },
);

const attemptRemoteThreadMeta$ = command(
  async (
    { set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<RemoteThreadMetaAttempt> => {
    const result = await settle(
      set(fetchRemoteThreadMeta$, threadId, signal),
      signal,
    );
    if (!result.ok) {
      set(captureChatThreadMetadataShortcut$, "transport-failure");
      return { source: "metadata-unavailable" };
    }
    set(captureChatThreadMetadataShortcut$, result.value.outcome);
    if (result.value.meta === null) {
      return { source: "metadata-unavailable" };
    }
    return { source: "metadata", meta: result.value.meta };
  },
);

async function resolveThreadMetaAttempts(
  metadata: Promise<RemoteThreadMetaAttempt>,
  eventStream: Promise<ColdThreadMetaResolution>,
): Promise<ColdThreadMetaResolution> {
  const first = await Promise.race([metadata, eventStream]);
  return first.source === "metadata-unavailable" ? eventStream : first;
}

const resolveColdThreadMeta$ = command(
  async (
    { set },
    threadId: string,
    meta$: Computed<ThreadMeta | null>,
    canonicalSync: Promise<void>,
    signal: AbortSignal,
  ): Promise<ColdThreadMetaResolution> => {
    const controller = createChildAbortController(signal);
    const metadata = set(attemptRemoteThreadMeta$, threadId, controller.signal);
    const eventStream = set(
      lookupEventStreamThreadMeta$,
      meta$,
      canonicalSync,
      controller.signal,
    );
    return await withCleanup(
      resolveThreadMetaAttempts(metadata, eventStream),
      () => {
        controller.abort(
          new DOMException("Thread metadata resolved", "AbortError"),
        );
      },
    );
  },
);

export const resolveThreadMeta$ = command(
  async (
    { get, set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<ResolvedThreadMeta> => {
    const meta$ = threadMeta(threadId);
    let meta = get(meta$);
    if (meta) {
      return { meta, source: "memory" };
    }

    const localStartedAt = performance.now();
    await waitForSharedWork(get(initialLocalChatThreadEventsLoaded$), signal);
    signal.throwIfAborted();
    const localDurationMs = Math.round(performance.now() - localStartedAt);
    meta = get(meta$);
    if (meta) {
      return { localDurationMs, meta, source: "local" };
    }

    const remoteStartedAt = performance.now();
    const initialRemoteSync = get(initialRemoteChatThreadEventsSyncedDeferred$);
    const foregroundReady = get(foregroundReady$);
    const foregroundSyncBarrier = get(chatThreadEventSyncBarrier$);
    const foregroundSync =
      initialRemoteSync.settled() &&
      (foregroundReady.pending || foregroundSyncBarrier.inFlight)
        ? foregroundSyncBarrier.next.promise
        : null;
    if (foregroundSync) {
      await waitForSharedWork(foregroundReady.promise, signal);
      await waitForSharedWork(foregroundSync, signal);
      signal.throwIfAborted();
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

    const syncBarrier = get(chatThreadEventSyncBarrier$);
    const canonicalSync = syncBarrier.inFlight
      ? syncBarrier.next.promise
      : initialRemoteSync.promise;
    const syncVersion = get(chatThreadEventSyncVersion$);
    const resolution = await set(
      resolveColdThreadMeta$,
      threadId,
      meta$,
      canonicalSync,
      signal,
    );
    signal.throwIfAborted();
    if (resolution.meta && resolution.source === "metadata") {
      const registered = set(
        registerBootstrapThreadMeta$,
        resolution.meta,
        syncVersion,
        signal,
      );
      if (!registered) {
        meta = get(canonicalThreadMetaMap$).get(threadId) ?? null;
        return {
          localDurationMs,
          meta,
          remoteDurationMs: Math.round(performance.now() - remoteStartedAt),
          source: meta ? "remote" : "not_found",
        };
      }
    }
    return {
      localDurationMs,
      meta: resolution.meta,
      remoteDurationMs: Math.round(performance.now() - remoteStartedAt),
      source: resolution.meta ? "remote" : "not_found",
    };
  },
);

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
