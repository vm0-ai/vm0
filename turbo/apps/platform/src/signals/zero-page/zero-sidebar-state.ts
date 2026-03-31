import { command, computed, state } from "ccstate";

// ---------------------------------------------------------------------------
// Sidebar search state
// ---------------------------------------------------------------------------
const internalSearchOpen$ = state(false);
export const sidebarSearchOpen$ = computed((get) => {
  return get(internalSearchOpen$);
});

const internalSearchTerm$ = state("");
export const sidebarSearchTerm$ = computed((get) => {
  return get(internalSearchTerm$);
});

export const setSidebarSearchOpen$ = command(({ set }, open: boolean) => {
  set(internalSearchOpen$, open);
  if (!open) {
    set(internalSearchTerm$, "");
  }
});

export const setSidebarSearchTerm$ = command(({ set }, term: string) => {
  set(internalSearchTerm$, term);
});

// ---------------------------------------------------------------------------
// Manage pinned agents dialog state
// ---------------------------------------------------------------------------
const internalManagePinnedOpen$ = state(false);
export const managePinnedDialogOpen$ = computed((get) => {
  return get(internalManagePinnedOpen$);
});
export const setManagePinnedDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalManagePinnedOpen$, open);
});

// ---------------------------------------------------------------------------
// Draft pinned IDs (for dialog editing before save)
// ---------------------------------------------------------------------------
const internalDraftPinnedIds$ = state<string[]>([]);
export const draftPinnedIds$ = computed((get) => {
  return get(internalDraftPinnedIds$);
});
export const setDraftPinnedIds$ = command(({ set }, ids: string[]) => {
  set(internalDraftPinnedIds$, ids);
});
