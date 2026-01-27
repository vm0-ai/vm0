import { computed, state } from "ccstate";

// Internal state for current log ID
const internalCurrentLogId$ = state<string | null>(null);

// Internal state for search term
const internalLogDetailSearchTerm$ = state("");

// Exported computed for read access
export const currentLogId$ = computed((get) => get(internalCurrentLogId$));

// Exported state-like interface for search term (needs read/write)
export const logDetailSearchTerm$ = internalLogDetailSearchTerm$;

// Export internal state for the page setup command to write to
export const setCurrentLogId$ = internalCurrentLogId$;
export const setLogDetailSearchTerm$ = internalLogDetailSearchTerm$;
