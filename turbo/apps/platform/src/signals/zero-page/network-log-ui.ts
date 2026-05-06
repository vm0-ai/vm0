import { state, computed, command } from "ccstate";

export function defaultNetworkLogTypes(): string[] {
  return ["HTTP"];
}

export type NetworkLogTypeFilter =
  | { readonly mode: "all" }
  | { readonly mode: "selected"; readonly types: readonly string[] };

function defaultNetworkLogTypeFilter(): NetworkLogTypeFilter {
  return { mode: "selected", types: defaultNetworkLogTypes() };
}

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

// ---------------------------------------------------------------------------
// Network log type filter
// ---------------------------------------------------------------------------

const internalNetworkLogTypeFilter$ = state<NetworkLogTypeFilter>(
  defaultNetworkLogTypeFilter(),
);

export const networkLogTypeFilter$ = computed((get) => {
  return get(internalNetworkLogTypeFilter$);
});

export const setNetworkLogTypeFilter$ = command(
  ({ set }, filter: NetworkLogTypeFilter) => {
    set(internalNetworkLogTypeFilter$, filter);
  },
);
