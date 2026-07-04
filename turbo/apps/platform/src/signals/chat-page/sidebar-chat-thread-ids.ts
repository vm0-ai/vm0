import { computed } from "ccstate";

import { chatThreads$ } from "../agent-chat.ts";

export const sidebarChatThreadIds$ = computed(
  async (get): Promise<readonly string[]> => {
    const persisted = await get(chatThreads$);
    const ids = new Set(
      persisted.map((thread) => {
        return thread.id;
      }),
    );

    return [...ids];
  },
);
