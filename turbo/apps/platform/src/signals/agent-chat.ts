import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadListItem,
  type CodexServiceTier,
} from "@vm0/api-contracts/contracts/chat-threads";
import { agentById, currentAgentId$, defaultAgentId$ } from "./agent.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import {
  reloadChatThreadsCounter$,
  reloadChatUnreadStateCounter$,
} from "./chat-thread-list-reload.ts";
import { chatThreadOnlyUnread$ } from "./chat-page/chat-thread-only-unread.ts";
import {
  eventDrivenActiveRunChatThreadIds$,
  chatThreadMetaMap$,
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
    return (await get(chatThreadMetaMap$)).get(threadId)?.agentId ?? null;
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
  lastReadMessageId: string | null;
  selectedModel: string | null;
  codexServiceTier: CodexServiceTier | null;
  computerUseHostId: string | null;
}

const filteredThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string> | null> => {
    if (!get(chatThreadOnlyUnread$)) {
      return null;
    }
    get(reloadChatUnreadStateCounter$);

    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return new Set();
    }

    const client = get(zeroClient$)(chatThreadsContract);
    const result = await accept(client.unreads({ query: { agentId } }), [200]);
    return new Set(
      result.body.unreads.map((unread) => {
        return unread.threadId;
      }),
    );
  },
);

const eventDrivenFilteredChatThreads$ = computed(
  async (get): Promise<EventDrivenChatThread[]> => {
    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return [];
    }
    const filteredThreadIds = await get(filteredThreadIds$);
    return (await get(eventDrivenChatThreads$)).filter((thread) => {
      return (
        thread.agentId === agentId &&
        (filteredThreadIds === null || filteredThreadIds.has(thread.id))
      );
    });
  },
);

const eventDrivenVisibleChatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const threads = await get(eventDrivenFilteredChatThreads$);
    const activeRunThreadIds = get(eventDrivenActiveRunChatThreadIds$);

    return threads.map((thread) => {
      return eventDrivenThreadToListItem(thread, activeRunThreadIds);
    });
  },
);

export const chatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    get(reloadChatThreadsCounter$);
    return await get(eventDrivenVisibleChatThreads$);
  },
);

export const currentChatThreadListIds$ = computed(
  async (get): Promise<readonly string[]> => {
    const threads = await get(eventDrivenFilteredChatThreads$);
    return threads.map((thread) => {
      return thread.id;
    });
  },
);

function eventDrivenThreadToListItem(
  thread: EventDrivenChatThread,
  activeRunThreadIds: ReadonlySet<string>,
): ChatThreadListItem {
  return {
    id: thread.id,
    title: thread.title,
    agent: {
      id: thread.agentId,
      avatarUrl: null,
    },
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    running: activeRunThreadIds.has(thread.id),
    pinnedAt: thread.pinnedAt,
    renamedAt: thread.renamedAt,
  };
}

export const allChatThreadListItems$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const activeRunThreadIds = get(eventDrivenActiveRunChatThreadIds$);
    return (await get(eventDrivenChatThreads$)).map((thread) => {
      return eventDrivenThreadToListItem(thread, activeRunThreadIds);
    });
  },
);
