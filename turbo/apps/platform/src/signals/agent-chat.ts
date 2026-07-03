import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadListItem,
  type PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  agentById,
  agents$,
  currentAgentId$,
  defaultAgentId$,
} from "./agent.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { reloadChatThreadsCounter$ } from "./chat-thread-list-reload.ts";
import { clerk$ } from "./auth.ts";
import { readThreadMeta$ } from "./external/idb-thread-meta-store.ts";
import { chatThreadOnlyUnread$ } from "./chat-page/chat-thread-only-unread.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import {
  chatThreadMaxItem$,
  eventDrivenChatThreads$,
} from "./chat-page/chat-thread-event-sourcing.ts";
import type { EventDrivenChatThread } from "./chat-page/chat-thread-event-replay.ts";

export { reloadChatThreads$ } from "./chat-thread-list-reload.ts";

const internalChatAgentId$ = state<string | null>(null);

export const setChatAgentId$ = command(({ set }, agentId: string | null) => {
  set(internalChatAgentId$, agentId);
});

export const currentChatThreadId$ = computed((get): string | null => {
  const params = get(pathParams$);
  const threadId = params?.threadId;
  const route = get(activeRoute$);
  if (route !== "chat") {
    return null;
  }
  return typeof threadId === "string" ? threadId : null;
});

const currentChatThreadAgentId$ = computed(
  async (get): Promise<string | null> => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      return null;
    }

    const clerk = await get(clerk$);
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    if (!userId || !orgId) {
      return null;
    }

    const meta = await readThreadMeta$(userId, orgId, threadId);
    return meta?.agentId ?? null;
  },
);

export const currentChatAgentId$ = computed(
  async (get): Promise<string | null> => {
    return (
      (await get(currentChatThreadAgentId$)) ??
      get(internalChatAgentId$) ??
      get(currentAgentId$) ??
      (await get(defaultAgentId$))
    );
  },
);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const currentChatAgentRecordId$ = computed(
  async (get): Promise<string | null> => {
    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return null;
    }

    if (uuidPattern.test(agentId)) {
      return agentId;
    }

    return (await get(agentById(agentId))).agentId;
  },
);

export const currentChatAgent$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return null;
  }

  return await get(agentById(agentId));
});

export const currentChatAgentDisplayName$ = computed(async (get) => {
  return (await get(currentChatAgent$))?.displayName;
});

export interface ChatThread {
  id: string;
  agentId: string;
  title: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastReadMessageId: string | null;
  lastReadAt: string | null;
  lastMessageAt: string;
  pinnedAt?: string | null;
  activeRunIds: string[];
  isLegacySession: boolean;
  draftContent: string | null;
  draftAttachments: PersistedAttachment[] | null;
  /**
   * Per-thread selected model pin. Provider routing is resolved from the
   * current org policy when sending.
   */
  modelProviderId: string | null;
  selectedModel: string | null;
  computerUseHostId: string | null;
}

/**
 * First-page sidebar fetch: pinned (full) + up to 25 non-pinned. Returns the
 * raw page so derived signals (chatThreads$, hasMore, nextCursor) can share a
 * single network round-trip.
 */
export const chatThreadEventSourcingEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ChatThreadEventSourcing] ?? false;
});

const legacyChatThreadsFirstPage$ = computed(async (get) => {
  get(reloadChatThreadsCounter$);

  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return null;
  }
  const onlyUnread = get(chatThreadEventSourcingEnabled$)
    ? false
    : get(chatThreadOnlyUnread$);

  const client = get(zeroClient$)(chatThreadsContract);
  const result = await accept(
    client.list({
      query: {
        agentId: agentId,
        ...(onlyUnread ? { filter: "unread" as const } : {}),
      },
    }),
    [200],
  );
  return result.body;
});

const legacyChatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const page = await get(legacyChatThreadsFirstPage$);
    if (!page) {
      return [];
    }
    return [...page.pinned, ...page.threads];
  },
);

const eventDrivenFilteredChatThreads$ = computed(
  async (get): Promise<EventDrivenChatThread[]> => {
    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return [];
    }
    return (await get(eventDrivenChatThreads$)).filter((thread) => {
      return thread.agentId === agentId;
    });
  },
);

const eventDrivenVisibleChatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const [threads, allAgents, legacyThreads] = await Promise.all([
      get(eventDrivenFilteredChatThreads$),
      get(agents$),
      get(legacyChatThreads$),
    ]);
    const maxItems = get(chatThreadMaxItem$);
    const avatarByAgentId = new Map(
      allAgents.map((agent) => {
        return [agent.id, agent.avatarUrl ?? null] as const;
      }),
    );
    const runningByThreadId = new Map(
      legacyThreads.map((thread) => {
        return [thread.id, thread.running] as const;
      }),
    );

    return threads.slice(0, maxItems).map((thread) => {
      return {
        id: thread.id,
        title: thread.title,
        agent: {
          id: thread.agentId,
          avatarUrl: avatarByAgentId.get(thread.agentId) ?? null,
        },
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        running: runningByThreadId.get(thread.id) ?? false,
        pinnedAt: thread.pinnedAt,
        renamedAt: thread.renamedAt,
      };
    });
  },
);

export const chatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    if (get(chatThreadEventSourcingEnabled$)) {
      return await get(eventDrivenVisibleChatThreads$);
    }
    return await get(legacyChatThreads$);
  },
);

/**
 * True when more non-pinned threads exist beyond the sidebar's 25-row cap.
 * Drives the "Load more" button rendered at the bottom of the sidebar list.
 */
export const chatThreadsHasMore$ = computed(async (get) => {
  if (get(chatThreadEventSourcingEnabled$)) {
    const threads = await get(eventDrivenFilteredChatThreads$);
    return threads.length > get(chatThreadMaxItem$);
  }
  const page = await get(legacyChatThreadsFirstPage$);
  return page?.hasMore ?? false;
});

export const chatThreadsNextCursor$ = computed(async (get) => {
  if (get(chatThreadEventSourcingEnabled$)) {
    const threads = await get(eventDrivenFilteredChatThreads$);
    return threads.length > get(chatThreadMaxItem$) ? "event-driven" : null;
  }
  const page = await get(legacyChatThreadsFirstPage$);
  return page?.nextCursor ?? null;
});
