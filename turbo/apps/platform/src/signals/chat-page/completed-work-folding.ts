import { command, computed, state } from "ccstate";

const internalCompletedWorkExpandedKeys$ = state<Set<string>>(new Set());

export const completedWorkExpandedKeys$ = computed((get): Set<string> => {
  return get(internalCompletedWorkExpandedKeys$);
});

export const toggleCompletedWorkExpanded$ = command(({ set }, key: string) => {
  set(internalCompletedWorkExpandedKeys$, (prev) => {
    const next = new Set(prev);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
});
