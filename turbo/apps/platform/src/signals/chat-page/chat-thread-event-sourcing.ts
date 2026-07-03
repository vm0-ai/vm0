import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@vm0/api-contracts/contracts/trpc-contract";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { clerk$ } from "../auth.ts";
import { createIdbChatThreadEventStores } from "../external/idb-chat-thread-event-store.ts";
import { logger } from "../log.ts";
import { reloadChatThreadsCounter$ } from "../chat-thread-list-reload.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { settle, withCleanup } from "../utils.ts";
import { replayChatThreadEvents } from "./chat-thread-event-replay.ts";

const L = logger("ChatThreadEventSourcing");
const CHAT_THREAD_VISIBLE_PAGE_SIZE = 25;

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

export interface ThreadMeta {
  readonly threadId: string;
  readonly agentId: string;
  readonly title: string | null;
}

const optimisticChatThreadEventsState$ = state<readonly ChatThreadEvent[]>([]);
const chatThreadMaxItemState$ = state(CHAT_THREAD_VISIBLE_PAGE_SIZE);
const chatThreadEventSyncVersionState$ = state(0);
const chatThreadEventSyncInFlightState$ = state(false);

export const chatThreadMaxItem$ = computed((get) => {
  return get(chatThreadMaxItemState$);
});

const chatThreadEventStores$ = computed(async (get): Promise<Stores | null> => {
  const clerk = await get(clerk$);
  const userId = clerk.user?.id;
  const orgId = clerk.organization?.id;
  if (!userId || !orgId) {
    return null;
  }

  return createIdbChatThreadEventStores(userId, orgId);
});

async function replaceFromRemoteSnapshot(
  store: Stores["writeStore"],
  client: ChatThreadsClient,
  signal?: AbortSignal,
): Promise<ChatThreadSnapshotData> {
  const result = await accept(
    client.snapshot({ fetchOptions: { signal } }),
    [200],
    { toast: false },
  );
  signal?.throwIfAborted();
  await store.replaceFromSnapshot(result.body, signal);
  return result.body;
}

async function syncChatThreadEvents(
  store: Stores,
  client: ChatThreadsClient,
  signal?: AbortSignal,
): Promise<ChatThreadSnapshotData | null> {
  const existingSnapshot = await store.readStore.readSnapshot(signal);
  let activeSnapshot = existingSnapshot;
  let cursor = await store.readStore.readLatestEventId(signal);
  if (!activeSnapshot) {
    activeSnapshot = await replaceFromRemoteSnapshot(
      store.writeStore,
      client,
      signal,
    );
    cursor = activeSnapshot.latestEventId;
  }

  for (let page = 0; page < 20; page++) {
    const result = await accept(
      client.events({
        query: cursor ? { sinceEventId: cursor } : {},
        fetchOptions: { signal },
      }),
      [200, 410],
      { toast: false },
    );
    signal?.throwIfAborted();

    if (result.status === 410) {
      L.debug("events cursor expired, reloading snapshot");
      activeSnapshot = await replaceFromRemoteSnapshot(
        store.writeStore,
        client,
        signal,
      );
      cursor = activeSnapshot.latestEventId;
      continue;
    }

    if (result.body.events.length > 0) {
      await store.writeStore.upsertEvents(result.body.events, signal);
      cursor = result.body.events[result.body.events.length - 1]!.id;
    }

    if (!result.body.hasMore || result.body.events.length === 0) {
      return activeSnapshot;
    }
  }
  return activeSnapshot;
}

const chatThreadEventData$ = computed(
  async (get): Promise<ChatThreadEventData> => {
    get(reloadChatThreadsCounter$);
    get(chatThreadEventSyncVersionState$);
    const store = await get(chatThreadEventStores$);
    if (!store) {
      return { snapshot: [], events: [] };
    }

    const cachedSnapshot = await store.readStore.readSnapshot();
    let syncedSnapshot: ChatThreadSnapshotData | null = null;
    if (!cachedSnapshot) {
      const client = get(zeroClient$)(chatThreadsContract);
      syncedSnapshot = await syncChatThreadEvents(store, client);
    }

    const [snapshot, events] = await Promise.all([
      store.readStore.readSnapshot(),
      store.readStore.readEvents(),
    ]);
    return {
      snapshot: (snapshot ?? syncedSnapshot)?.chatThreads ?? [],
      events,
    };
  },
);

export const syncEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const store = await get(chatThreadEventStores$);
    signal.throwIfAborted();
    if (!store || get(chatThreadEventSyncInFlightState$)) {
      return;
    }

    set(chatThreadEventSyncInFlightState$, true);
    await withCleanup(
      (async () => {
        const client = get(zeroClient$)(chatThreadsContract);
        const synced = await settle(
          syncChatThreadEvents(store, client, signal),
          signal,
        );
        if (!synced.ok) {
          L.debug("event sync failed", { error: synced.error });
          return;
        }
        signal.throwIfAborted();
        set(chatThreadEventSyncVersionState$, (version) => {
          return version + 1;
        });
      })(),
      () => {
        set(chatThreadEventSyncInFlightState$, false);
      },
    );
  },
);

export const subscribeEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (!get(featureSwitch$)[FeatureSwitchKey.ChatThreadEventSourcing]) {
      return;
    }

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

export const chatThreadsSnapshot$ = computed(async (get) => {
  return (await get(chatThreadEventData$)).snapshot;
});

const allChatThreadsEvents$ = computed(async (get) => {
  const persisted = (await get(chatThreadEventData$)).events;
  const optimistic = get(optimisticChatThreadEventsState$);
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

export const eventDrivenChatThreadMetaMap$ = computed(async (get) => {
  return new Map<string, ThreadMeta>(
    (await get(eventDrivenChatThreads$)).map((thread) => {
      return [
        thread.id,
        {
          threadId: thread.id,
          agentId: thread.agentId,
          title: thread.title,
        },
      ];
    }),
  );
});

export function eventDrivenChatThreadMeta(threadId: string) {
  return computed(async (get): Promise<ThreadMeta | null> => {
    return (await get(eventDrivenChatThreadMetaMap$)).get(threadId) ?? null;
  });
}

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

export const loadMoreEventDrivenChatThreads$ = command(({ set }) => {
  set(chatThreadMaxItemState$, (count) => {
    return count + CHAT_THREAD_VISIBLE_PAGE_SIZE;
  });
});
