import { command, computed, state } from "ccstate";

const internalCompletedWorkExpandedThreadIds$ = state<Set<string>>(new Set());

export const completedWorkExpandedThreadIds$ = computed((get): Set<string> => {
  return get(internalCompletedWorkExpandedThreadIds$);
});

export const toggleCompletedWorkExpanded$ = command(
  ({ set }, threadId: string) => {
    set(internalCompletedWorkExpandedThreadIds$, (prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  },
);
