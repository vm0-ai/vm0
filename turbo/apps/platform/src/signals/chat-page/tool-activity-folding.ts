import { command, computed, state } from "ccstate";

const internalToolActivityExpandedKeys$ = state<Set<string>>(new Set());

export const toolActivityExpandedKeys$ = computed((get): Set<string> => {
  return get(internalToolActivityExpandedKeys$);
});

export const toggleToolActivityExpanded$ = command(({ set }, key: string) => {
  set(internalToolActivityExpandedKeys$, (prev) => {
    const next = new Set(prev);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
});
