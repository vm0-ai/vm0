import { computed } from "ccstate";

import { chatThreadIndicatorsFromWorker$ } from "../shared-database.ts";

export const unreadAgentIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicatorsFromWorker$);
    return new Set(
      Object.entries(indicators.agents).flatMap(([agentId, indicator]) => {
        return indicator === "unread" ? [agentId] : [];
      }),
    );
  },
);

export const sidebarActiveThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicatorsFromWorker$);
    return new Set(
      Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
        return indicator === "active" ? [threadId] : [];
      }),
    );
  },
);
