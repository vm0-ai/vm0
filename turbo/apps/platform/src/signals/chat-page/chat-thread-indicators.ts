import { computed } from "ccstate";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { reloadChatIndicatorsCounter$ } from "../chat-thread-list-reload.ts";
import { chatThreadIndicatorsFromWorker$ } from "../shared-database.ts";

export const chatThreadIndicators$ = computed(async (get) => {
  get(reloadChatIndicatorsCounter$);
  if (get(apiClientRuntime$).environment === "app") {
    return await get(chatThreadIndicatorsFromWorker$);
  }
  const client = get(apiClient$)(chatThreadsContract);
  const result = await accept(client.indicators(), [200]);
  return result.body;
});

export const unreadAgentIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicators$);
    return new Set(
      Object.entries(indicators.agents).flatMap(([agentId, indicator]) => {
        return indicator === "unread" ? [agentId] : [];
      }),
    );
  },
);

export const allUnreadThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicators$);
    return new Set(
      Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
        return indicator === "unread" ? [threadId] : [];
      }),
    );
  },
);

export const sidebarActiveThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicators$);
    return new Set(
      Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
        return indicator === "active" ? [threadId] : [];
      }),
    );
  },
);
