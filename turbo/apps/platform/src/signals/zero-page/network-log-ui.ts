import { state, computed, command } from "ccstate";

// ---------------------------------------------------------------------------
// Network log row expanded state
// ---------------------------------------------------------------------------

const expandedNetworkLogRows$ = state(new Set<string>());

export const networkLogExpandedRows$ = computed((get) => {
  return get(expandedNetworkLogRows$);
});

export const toggleNetworkLogRowExpanded$ = command(
  ({ get, set }, rowKey: string) => {
    const current = get(expandedNetworkLogRows$);
    const next = new Set(current);
    if (next.has(rowKey)) {
      next.delete(rowKey);
    } else {
      next.add(rowKey);
    }
    set(expandedNetworkLogRows$, next);
  },
);
