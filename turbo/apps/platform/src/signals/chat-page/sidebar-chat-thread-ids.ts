import { computed } from "ccstate";

import { chatThreads$, currentChatAgentId$ } from "../agent-chat.ts";
import { allPendingChatThreads$ } from "./optimistic-chat-thread-state.ts";
import { sidebarChatThreadsExtraThreads$ } from "./sidebar-chat-threads-pagination.ts";

export const sidebarChatThreadIds$ = computed(
  async (get): Promise<readonly string[]> => {
    const persisted = await get(chatThreads$);
    const extraPersisted = await get(sidebarChatThreadsExtraThreads$);
    const ids = new Set(
      [...persisted, ...extraPersisted].map((thread) => {
        return thread.id;
      }),
    );

    const currentAgentId = await get(currentChatAgentId$);
    if (currentAgentId) {
      for (const thread of get(allPendingChatThreads$)) {
        if (thread.agentId === currentAgentId) {
          ids.add(thread.threadId);
        }
      }
    }

    return [...ids];
  },
);
