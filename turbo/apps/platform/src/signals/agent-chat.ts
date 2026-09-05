import { command, computed, state } from "ccstate";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";
import { agentById, currentAgentId$, defaultAgentId$ } from "./agent.ts";
import { apiClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { stableChatThreadNavigationEnabled$ } from "./external/feature-switch.ts";
import { reloadChatIndicatorsCounter$ } from "./chat-thread-list-reload.ts";
import { chatThreadOnlyUnread$ } from "./chat-page/chat-thread-only-unread.ts";
import {
  chatThreadMetaMap$,
  eventDrivenChatThreads$,
} from "./chat-page/chat-thread-event-sourcing.ts";

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

const currentChatThreadAgentId$ = computed((get): string | null => {
  const threadId = get(currentChatThreadId$);
  if (!threadId) {
    return null;
  }
  return get(chatThreadMetaMap$).get(threadId)?.agentId ?? null;
});

export const currentChatAgentScope$ = computed((get): string | null => {
  return (
    get(currentChatThreadAgentId$) ??
    get(internalChatAgentId$) ??
    get(currentAgentId$)
  );
});

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

const filteredThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string> | null> => {
    if (!get(chatThreadOnlyUnread$)) {
      return null;
    }
    get(reloadChatIndicatorsCounter$);

    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return new Set();
    }

    const client = get(apiClient$)(chatThreadsContract);
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
    const threads = get(eventDrivenChatThreads$).filter((thread) => {
      return (
        thread.agentId === agentId &&
        (filteredThreadIds === null || filteredThreadIds.has(thread.id))
      );
    });
    if (!get(stableChatThreadNavigationEnabled$)) {
      return threads;
    }
    return threads.sort((left, right) => {
      if (left.pinnedAt === null) {
        return right.pinnedAt === null ? 0 : 1;
      }
      if (right.pinnedAt === null) {
        return -1;
      }
      return comparePinnedThreads(left, right);
    });
  },
);

export const chatThreads$ = eventDrivenFilteredChatThreads$;

export const currentChatThreadListIds$ = computed(
  async (get): Promise<readonly string[]> => {
    const threads = await get(eventDrivenFilteredChatThreads$);
    return threads.map((thread) => {
      return thread.id;
    });
  },
);
