import { command, computed, state } from "ccstate";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { reloadChatUnreadStateCounter$ } from "../chat-thread-list-reload.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

type UnreadSnapshot = readonly { threadId: string; unreadAt: string }[];

/**
 * Local optimistic mark-read timestamps. A thread in the server unread
 * snapshot stays hidden while the local mark is newer than that snapshot.
 */
const optimisticReadMarks$ = state<ReadonlyMap<string, number>>(new Map());

export const recordOptimisticReadMark$ = command(
  ({ get, set }, threadId: string) => {
    const next = new Map(get(optimisticReadMarks$));
    next.set(threadId, now());
    set(optimisticReadMarks$, next);
  },
);

export const applyUnreadSnapshot$ = command(
  ({ get, set }, unreads: UnreadSnapshot) => {
    const marks = get(optimisticReadMarks$);
    if (marks.size === 0) {
      return;
    }
    const next = new Map(marks);
    for (const unread of unreads) {
      const markedAt = next.get(unread.threadId);
      if (markedAt !== undefined && Date.parse(unread.unreadAt) > markedAt) {
        next.delete(unread.threadId);
      }
    }
    if (next.size !== marks.size) {
      set(optimisticReadMarks$, next);
    }
  },
);

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
    const marks = get(optimisticReadMarks$);
    const ids = new Set<string>();
    for (const unread of unreads) {
      const markedAt = marks.get(unread.threadId);
      if (markedAt === undefined || Date.parse(unread.unreadAt) > markedAt) {
        ids.add(unread.threadId);
      }
    }
    return ids;
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
