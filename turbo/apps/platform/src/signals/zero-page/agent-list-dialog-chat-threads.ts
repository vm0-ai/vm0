import { computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { EventDrivenChatThread } from "@vm0/core/chat-thread-event-replay";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  eventDrivenChatThreads$,
  sidebarActiveThreadIds$,
} from "../chat-page/chat-thread-event-sourcing.ts";
import { sidebarUnreadThreadIds$ } from "../chat-page/sidebar-unread-threads.ts";
import { chatListQuery$ } from "./zero-sidebar-state.ts";

const MAX_VISIBLE_CHAT_THREAD_RESULTS = 25;

type AgentListDialogChatThreadIndicator = "running" | "unread" | null;

export interface AgentListDialogChatThread {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly indicator: AgentListDialogChatThreadIndicator;
}

export interface AgentListDialogChatThreadResult {
  readonly query: string;
  readonly chatThreads: readonly AgentListDialogChatThread[];
}

export const chatThreadUnifiedSearchEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ChatThreadUnifiedSearch] ?? false;
});

export const agentListDialogChatThreads$ = computed(
  async (get): Promise<AgentListDialogChatThreadResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (!get(chatThreadUnifiedSearchEnabled$)) {
      return { query, chatThreads: [] };
    }

    const threads = await get(eventDrivenChatThreads$);
    const matchingThreads: {
      readonly thread: EventDrivenChatThread;
      readonly title: string;
    }[] = [];
    for (const thread of threads) {
      const title = thread.title ?? "New chat";
      if (query && !title.toLowerCase().includes(query)) {
        continue;
      }
      matchingThreads.push({ thread, title });
      if (matchingThreads.length === MAX_VISIBLE_CHAT_THREAD_RESULTS) {
        break;
      }
    }
    if (matchingThreads.length === 0) {
      return { query, chatThreads: [] };
    }

    const [activeThreadIds, unreadThreadIds] = await Promise.all([
      get(sidebarActiveThreadIds$),
      get(sidebarUnreadThreadIds$),
    ]);

    const chatThreads: AgentListDialogChatThread[] = matchingThreads.map(
      ({ thread, title }) => {
        const indicator = activeThreadIds.has(thread.id)
          ? "running"
          : unreadThreadIds.has(thread.id)
            ? "unread"
            : null;
        return {
          id: thread.id,
          title,
          agentId: thread.agentId,
          indicator,
        };
      },
    );
    return { query, chatThreads };
  },
);
