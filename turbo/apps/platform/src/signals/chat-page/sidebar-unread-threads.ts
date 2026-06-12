import { command, computed, state } from "ccstate";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { reloadChatThreadsCounter$ } from "../chat-thread-list-reload.ts";

type UnreadSnapshot = readonly { threadId: string; unreadAt: string }[];

/**
 * Local optimistic mark-read timestamps (threadId → epoch ms, recorded when
 * the mark-read POST fires). A thread present in the server unread snapshot
 * is still rendered as read while a local mark exists — until a snapshot
 * reports an `unreadAt` NEWER than the mark, which means a fresh message
 * arrived after the user read the thread and the optimistic entry must be
 * kicked. This absorbs the race between mark-read and an in-flight unreads
 * fetch without any server broadcast.
 */
const optimisticReadMarks$ = state<ReadonlyMap<string, number>>(new Map());

export const recordOptimisticReadMark$ = command(
  ({ get, set }, threadId: string) => {
    const next = new Map(get(optimisticReadMarks$));
    next.set(threadId, now());
    set(optimisticReadMarks$, next);
  },
);

/**
 * Kick optimistic marks that a server snapshot has overtaken. Called with
 * the snapshot from a mark-read response so a message that landed between
 * the fetch and the mark resurfaces immediately.
 */
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
 * thread list (same reload counter); mark-read does not broadcast, so reads
 * by this client are reflected through `optimisticReadMarks$` instead.
 */
const fetchedUnreads$ = computed(async (get): Promise<UnreadSnapshot> => {
  get(reloadChatThreadsCounter$);
  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return [];
  }
  const client = get(zeroClient$)(chatThreadsContract);
  const result = await accept(client.unreads({ query: { agentId } }), [200]);
  return result.body.unreads;
});

/**
 * Thread ids to render with the sidebar unread dot: the server snapshot
 * minus threads suppressed by a still-valid local mark.
 */
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
