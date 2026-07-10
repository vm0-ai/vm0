import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@vm0/api-contracts/contracts/trpc-contract";
import { accept } from "../../lib/accept.ts";
import { activeRoute$ } from "../active-route.ts";
import { zeroClient$ } from "../api-client.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { createIdbChatThreadEventStores } from "../external/idb-chat-thread-event-store.ts";
import { logger } from "../log.ts";
import { reloadChatActiveRunIdsCounter$ } from "../chat-thread-list-reload.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { pathParams$ } from "../route.ts";
import { replayChatThreadEvents } from "./chat-thread-event-replay.ts";

const L = logger("ChatThreadEventSourcing");

type Stores = ReturnType<typeof createIdbChatThreadEventStores>;
type ChatThreadsClient = InitClientReturn<ChatThreadsContract, InitClientArgs>;

interface ChatThreadEventData {
  readonly snapshot: readonly ChatThreadSnapshotProjection[];
  readonly events: readonly ChatThreadEvent[];
}

interface ChatThreadSnapshotData {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
}

interface ChatThreadEventState {
  readonly ownerKey: string;
  readonly snapshot: ChatThreadSnapshotData | null;
  readonly events: readonly ChatThreadEvent[];
}

interface ChatThreadEventStores {
  readonly ownerKey: string;
  readonly stores: Stores;
}

interface ChatThreadEventUpdate {
  readonly state: ChatThreadEventState;
  readonly replacementSnapshot: ChatThreadSnapshotData | null;
  readonly newEvents: readonly ChatThreadEvent[];
}

export interface ThreadMeta {
  readonly id: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly pinnedAt: string | null;
  readonly selectedModel: string | null;
}

const optimisticChatThreadEventsState$ = state<readonly ChatThreadEvent[]>([]);
const chatThreadEventState$ = state<ChatThreadEventState | null>(null);

const optimisticChatThreadCreateIds$ = computed((get): ReadonlySet<string> => {
  return new Set(
    get(optimisticChatThreadEventsState$).flatMap((event) => {
      return event.kind === "created" ? [event.chatThreadId] : [];
    }),
  );
});

function filterUnsettledOptimisticChatThreadEvents(
  optimistic: readonly ChatThreadEvent[],
  persisted: ChatThreadEventData,
): ChatThreadEvent[] {
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
  ownerKey: string,
  store: Stores,
  signal?: AbortSignal,
): Promise<ChatThreadEventState> {
  const [snapshot, events] = await Promise.all([
    store.readStore.readSnapshot(signal),
    store.readStore.readEvents(signal),
  ]);
  return {
    ownerKey,
    snapshot,
    events,
  };
}

export const eventDrivenActiveRunChatThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    get(reloadChatActiveRunIdsCounter$);
    const client = get(zeroClient$)(chatThreadsContract);
    const result = await accept(client.activeIds(), [200]);
    return new Set(result.body.threadIds);
  },
);

const chatThreadEventStores$ = computed(
  async (get): Promise<ChatThreadEventStores> => {
    const { userId, orgId } = await get(authenticatedIdentity$);
    return {
      ownerKey: `${userId}:${orgId}`,
      stores: createIdbChatThreadEventStores(userId, orgId),
    };
  },
);

const lastEventId$ = computed((get): string | null => {
  const state = get(chatThreadEventState$);
  return state?.events.at(-1)?.id ?? state?.snapshot?.latestEventId ?? null;
});

async function fetchRemoteSnapshot(
  client: ChatThreadsClient,
  signal?: AbortSignal,
): Promise<ChatThreadSnapshotData> {
  const result = await accept(
    client.snapshot({ fetchOptions: { signal } }),
    [200],
  );
  signal?.throwIfAborted();
  return result.body;
}

async function fetchChatThreadEventUpdate(
  currentState: ChatThreadEventState,
  initialCursor: string | null,
  client: ChatThreadsClient,
  signal?: AbortSignal,
): Promise<ChatThreadEventUpdate | null> {
  let snapshot = currentState.snapshot;
  let events = currentState.events;
  let cursor = initialCursor;
  let snapshotReplaced = false;
  let newEvents: readonly ChatThreadEvent[] = [];

  if (!snapshot || cursor === null) {
    snapshot = await fetchRemoteSnapshot(client, signal);
    events = [];
    cursor = snapshot.latestEventId;
    snapshotReplaced = true;
  }

  for (let page = 0; page < 20; page++) {
    const result = await accept(
      client.events({
        query: cursor ? { sinceEventId: cursor } : {},
        fetchOptions: { signal },
      }),
      [200, 410],
    );
    signal?.throwIfAborted();

    if (result.status === 410) {
      L.debug("events cursor expired, reloading snapshot");
      snapshot = await fetchRemoteSnapshot(client, signal);
      events = [];
      newEvents = [];
      cursor = snapshot.latestEventId;
      snapshotReplaced = true;
      continue;
    }

    if (result.body.events.length > 0) {
      events = [...events, ...result.body.events];
      newEvents = [...newEvents, ...result.body.events];
      cursor = result.body.events[result.body.events.length - 1]!.id;
    }

    if (!result.body.hasMore || result.body.events.length === 0) {
      if (!snapshotReplaced && newEvents.length === 0) {
        return null;
      }
      return {
        state: {
          ownerKey: currentState.ownerKey,
          snapshot,
          events,
        },
        replacementSnapshot: snapshotReplaced ? snapshot : null,
        newEvents,
      };
    }
  }
  if (!snapshotReplaced && newEvents.length === 0) {
    return null;
  }
  return {
    state: {
      ownerKey: currentState.ownerKey,
      snapshot,
      events,
    },
    replacementSnapshot: snapshotReplaced ? snapshot : null,
    newEvents,
  };
}

const chatThreadEventData$ = computed(
  async (get): Promise<ChatThreadEventData> => {
    const storeContext = await get(chatThreadEventStores$);
    const state = get(chatThreadEventState$);
    if (state?.ownerKey !== storeContext.ownerKey) {
      return { snapshot: [], events: [] };
    }
    return {
      snapshot: state.snapshot?.chatThreads ?? [],
      events: state.events,
    };
  },
);

const hydrateChatThreadEventState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const storeContext = await get(chatThreadEventStores$);
    signal.throwIfAborted();
    const currentState = get(chatThreadEventState$);
    if (currentState?.ownerKey === storeContext.ownerKey) {
      return { state: currentState, store: storeContext.stores };
    }

    const state = await readChatThreadEventState(
      storeContext.ownerKey,
      storeContext.stores,
      signal,
    );
    signal.throwIfAborted();
    set(chatThreadEventState$, state);
    set(reconcileOptimisticChatThreadEvents$, {
      snapshot: state.snapshot?.chatThreads ?? [],
      events: state.events,
    });
    await set(syncCurrentChatThreadDocumentTitle$);
    return { state, store: storeContext.stores };
  },
);

export const syncEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const hydrated = await set(hydrateChatThreadEventState$, signal);
    signal.throwIfAborted();
    const client = get(zeroClient$)(chatThreadsContract);
    const update = await fetchChatThreadEventUpdate(
      hydrated.state,
      get(lastEventId$),
      client,
      signal,
    );
    signal.throwIfAborted();
    if (!update) {
      return;
    }

    if (update.replacementSnapshot) {
      await hydrated.store.writeStore.replaceFromSnapshot(
        update.replacementSnapshot,
        signal,
      );
    }
    await hydrated.store.writeStore.upsertEvents(update.newEvents, signal);
    set(chatThreadEventState$, update.state);
    set(reconcileOptimisticChatThreadEvents$, {
      snapshot: update.state.snapshot?.chatThreads ?? [],
      events: update.state.events,
    });
    await set(syncCurrentChatThreadDocumentTitle$);
  },
);

export const subscribeEventDrivenChatThreads$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const syncOnThreadListChanged$ = command(
      async ({ set }, signal: AbortSignal): Promise<boolean> => {
        await set(syncEventDrivenChatThreads$, signal);
        return false;
      },
    );

    await set(syncEventDrivenChatThreads$, signal);
    signal.throwIfAborted();
    await set(
      setAblyLoop$,
      { topic: "threadListChanged", loopCommand$: syncOnThreadListChanged$ },
      signal,
    );
  },
);

const chatThreadsSnapshot$ = computed(async (get) => {
  return (await get(chatThreadEventData$)).snapshot;
});

const allChatThreadsEvents$ = computed(async (get) => {
  const persistedData = await get(chatThreadEventData$);
  const persisted = persistedData.events;
  const optimistic = filterUnsettledOptimisticChatThreadEvents(
    get(optimisticChatThreadEventsState$),
    persistedData,
  );
  const byId = new Map<string, ChatThreadEvent>();
  for (const event of optimistic) {
    byId.set(event.id, event);
  }
  for (const event of persisted) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => {
    const timeCompare = a.createdAt.localeCompare(b.createdAt);
    if (timeCompare !== 0) {
      return timeCompare;
    }
    return a.id.localeCompare(b.id);
  });
});

export const eventDrivenChatThreads$ = computed(async (get) => {
  return replayChatThreadEvents(
    await get(chatThreadsSnapshot$),
    await get(allChatThreadsEvents$),
  );
});

const eventDrivenChatThreadMap$ = computed(async (get) => {
  return new Map(
    (await get(eventDrivenChatThreads$)).map((thread) => {
      return [thread.id, thread] as const;
    }),
  );
});

export function eventDrivenChatThread(threadId: string) {
  return computed(async (get) => {
    return (await get(eventDrivenChatThreadMap$)).get(threadId) ?? null;
  });
}

export function optimisticChatThreadCreateUnsettled(threadId: string) {
  return computed((get): boolean => {
    return get(optimisticChatThreadCreateIds$).has(threadId);
  });
}

export const chatThreadMetaMap$ = computed(async (get) => {
  return new Map<string, ThreadMeta>(
    (await get(eventDrivenChatThreads$)).map((thread) => {
      return [
        thread.id,
        {
          id: thread.id,
          agentId: thread.agentId,
          title: thread.title,
          pinnedAt: thread.pinnedAt,
          selectedModel: thread.selectedModel,
        },
      ];
    }),
  );
});

export function threadMeta(threadId: string) {
  return computed(async (get): Promise<ThreadMeta | null> => {
    return (await get(chatThreadMetaMap$)).get(threadId) ?? null;
  });
}

/** Synchronize the active primary chat tab title after committed thread data changes. */
const syncCurrentChatThreadDocumentTitle$ = command(async ({ get, set }) => {
  if (get(activeRoute$) !== "chat") {
    return;
  }
  const threadId = get(pathParams$)?.threadId;
  if (typeof threadId !== "string") {
    return;
  }
  const meta = await get(threadMeta(threadId));
  if (meta) {
    set(updateDocumentTitle$, meta.title ?? "New chat");
  }
});

export const registerOptimisticChatThreadEvent$ = command(
  ({ set }, event: ChatThreadEvent) => {
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
      createdAt: args.createdAt,
    } satisfies ChatThreadEvent);
  },
);

export const reconcileOptimisticChatThreadEvents$ = command(
  ({ set }, persisted: ChatThreadEventData) => {
    set(optimisticChatThreadEventsState$, (events) => {
      return filterUnsettledOptimisticChatThreadEvents(events, persisted);
    });
  },
);
