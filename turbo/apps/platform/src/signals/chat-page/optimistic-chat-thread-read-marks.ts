import { command, computed, state } from "ccstate";

import { now } from "../../lib/time.ts";

type UnreadSnapshot = readonly { threadId: string; unreadAt: string }[];

/**
 * Local optimistic mark-read timestamps. A thread in the server unread
 * snapshot stays hidden while the local mark is newer than that snapshot.
 */
const internalOptimisticReadMarks$ = state<ReadonlyMap<string, number>>(
  new Map(),
);

export const optimisticReadMarks$ = computed((get) => {
  return get(internalOptimisticReadMarks$);
});

export const recordOptimisticReadMark$ = command(
  ({ get, set }, threadId: string) => {
    const next = new Map(get(internalOptimisticReadMarks$));
    next.set(threadId, now());
    set(internalOptimisticReadMarks$, next);
  },
);

export const clearOptimisticReadMark$ = command(
  ({ get, set }, threadId: string) => {
    const marks = get(internalOptimisticReadMarks$);
    if (!marks.has(threadId)) {
      return;
    }
    const next = new Map(marks);
    next.delete(threadId);
    set(internalOptimisticReadMarks$, next);
  },
);

export const applyUnreadSnapshot$ = command(
  ({ get, set }, unreads: UnreadSnapshot) => {
    const marks = get(internalOptimisticReadMarks$);
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
      set(internalOptimisticReadMarks$, next);
    }
  },
);
