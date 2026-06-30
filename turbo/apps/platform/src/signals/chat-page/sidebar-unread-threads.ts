import { computed } from "ccstate";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { reloadChatUnreadStateCounter$ } from "../chat-thread-list-reload.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

type UnreadSnapshot = readonly { threadId: string; unreadAt: string }[];

/**
 * Server unread snapshot for the current agent. Refetched alongside the
 * unread-state counter. Thread-list changes and read-cursor updates both
 * invalidate this counter through Ably.
 */
const fetchedUnreads$ = computed(async (get): Promise<UnreadSnapshot> => {
  get(reloadChatUnreadStateCounter$);
  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return [];
  }
  const client = get(zeroClient$)(chatThreadsContract);
  const result = await accept(client.unreads({ query: { agentId } }), [200]);
  return result.body.unreads;
});

export const sidebarUnreadThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const unreads = await get(fetchedUnreads$);
    return new Set(
      unreads.map((unread) => {
        return unread.threadId;
      }),
    );
  },
);

export const unreadAgentIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    get(reloadChatUnreadStateCounter$);
    const features = get(featureSwitch$);
    if (!features[FeatureSwitchKey.AgentUnreadIndicators]) {
      return new Set();
    }
    const client = get(zeroClient$)(chatThreadsContract);
    const result = await accept(client.unreadAgents(), [200], {
      toast: false,
    });
    return new Set(result.body.agentIds);
  },
);
