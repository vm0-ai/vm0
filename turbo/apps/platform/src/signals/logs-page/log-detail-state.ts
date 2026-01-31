import { computed, state } from "ccstate";

// Internal state for current log ID
const internalCurrentLogId$ = state<string | null>(null);

// Internal state for search term
const internalLogDetailSearchTerm$ = state("");

// View mode: 'formatted' shows styled cards, 'raw' shows JSON
export type ViewMode = "formatted" | "raw";
const internalViewMode$ = state<ViewMode>("formatted");

// Search navigation state
const internalCurrentMatchIndex$ = state(0);
const internalTotalMatchCount$ = state(0);

// Exported computed for read access
export const currentLogId$ = computed((get) => get(internalCurrentLogId$));

// Exported state-like interface for search term (needs read/write)
export const logDetailSearchTerm$ = internalLogDetailSearchTerm$;

// Exported view mode state
export const viewMode$ = internalViewMode$;

// Exported search navigation state
export const currentMatchIndex$ = internalCurrentMatchIndex$;
export const totalMatchCount$ = internalTotalMatchCount$;

// Export internal state for the page setup command to write to
export const setCurrentLogId$ = internalCurrentLogId$;
export const setLogDetailSearchTerm$ = internalLogDetailSearchTerm$;
