import { command, computed, state } from "ccstate";

// ---------------------------------------------------------------------------
// Active tab state
// ---------------------------------------------------------------------------
const internalActiveTab$ = state("all");
export const ideationActiveTab$ = computed((get) => {
  return get(internalActiveTab$);
});
export const setIdeationActiveTab$ = command(({ set }, tab: string) => {
  set(internalActiveTab$, tab);
});

// ---------------------------------------------------------------------------
// Search query state
// ---------------------------------------------------------------------------
const internalSearchQuery$ = state("");
export const ideationSearchQuery$ = computed((get) => {
  return get(internalSearchQuery$);
});
export const setIdeationSearchQuery$ = command(({ set }, query: string) => {
  set(internalSearchQuery$, query);
});
