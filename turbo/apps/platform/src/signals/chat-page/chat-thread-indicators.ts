import { computed } from "ccstate";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { reloadChatIndicatorsCounter$ } from "../chat-thread-list-reload.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

const unifiedIndicatorApiEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.UnifiedIndicatorApi] ?? false;
});

const chatThreadIndicators$ = computed(async (get) => {
  get(unifiedIndicatorApiEnabled$);
  get(reloadChatIndicatorsCounter$);
  const client = get(zeroClient$)(chatThreadsContract);
  const result = await accept(client.indicators(), [200]);
  return result.body;
});

export const unreadAgentIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    if (get(unifiedIndicatorApiEnabled$)) {
      const indicators = await get(chatThreadIndicators$);
      return new Set(
        Object.entries(indicators.agents).flatMap(([agentId, indicator]) => {
          return indicator === "unread" ? [agentId] : [];
        }),
      );
    }

    get(reloadChatIndicatorsCounter$);
    const client = get(zeroClient$)(chatThreadsContract);
    const result = await accept(client.unreadAgents(), [200]);
    return new Set(result.body.agentIds);
  },
);

export const allUnreadThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    if (get(unifiedIndicatorApiEnabled$)) {
      const indicators = await get(chatThreadIndicators$);
      return new Set(
        Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
          return indicator === "unread" ? [threadId] : [];
        }),
      );
    }

    get(reloadChatIndicatorsCounter$);
    const client = get(zeroClient$)(chatThreadsContract);
    const result = await accept(client.unreadIds(), [200]);
    return new Set(result.body.threadIds);
  },
);

export const sidebarActiveThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    if (get(unifiedIndicatorApiEnabled$)) {
      const indicators = await get(chatThreadIndicators$);
      return new Set(
        Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
          return indicator === "active" ? [threadId] : [];
        }),
      );
    }

    get(reloadChatIndicatorsCounter$);
    const client = get(zeroClient$)(chatThreadsContract);
    const result = await accept(client.activeIds(), [200]);
    return new Set(result.body.threadIds);
  },
);
