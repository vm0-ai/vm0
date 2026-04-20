import { command, computed, state } from "ccstate";

// ---------------------------------------------------------------------------
// Composer UI state — search, dialogs, loading indicators
// ---------------------------------------------------------------------------

// -- Add-connectors dialog --------------------------------------------------

const internalShowAddDialog$ = state(false);
export const showAddDialog$ = computed((get) => {
  return get(internalShowAddDialog$);
});
export const setShowAddDialog$ = command(({ set }, open: boolean) => {
  set(internalShowAddDialog$, open);
});

// -- Pending OAuth connection type ------------------------------------------

const internalPendingConnectType$ = state<string | null>(null);
export const pendingConnectType$ = computed((get) => {
  return get(internalPendingConnectType$);
});
export const setPendingConnectType$ = command(
  ({ set }, type: string | null) => {
    set(internalPendingConnectType$, type);
  },
);

// -- Connector toggle saving indicator --------------------------------------

const internalComposerSavingType$ = state<string | null>(null);
export const composerSavingType$ = computed((get) => {
  return get(internalComposerSavingType$);
});
export const setComposerSavingType$ = command(
  ({ set }, type: string | null) => {
    set(internalComposerSavingType$, type);
  },
);

// -- Add-connectors dialog search filter ------------------------------------

const internalAddDialogSearch$ = state("");
export const addDialogSearch$ = computed((get) => {
  return get(internalAddDialogSearch$);
});
export const setAddDialogSearch$ = command(({ set }, value: string) => {
  set(internalAddDialogSearch$, value);
});

// -- Connector popover search filter ----------------------------------------

const internalPopoverSearch$ = state("");
export const popoverSearch$ = computed((get) => {
  return get(internalPopoverSearch$);
});
export const setPopoverSearch$ = command(({ set }, value: string) => {
  set(internalPopoverSearch$, value);
});

// -- Connector popover sort order snapshot ----------------------------------

const internalPopoverSortOrder$ = state<string[] | null>(null);
export const popoverSortOrder$ = computed((get) => {
  return get(internalPopoverSortOrder$);
});
export const setPopoverSortOrder$ = command(
  ({ set }, order: string[] | null) => {
    set(internalPopoverSortOrder$, order);
  },
);
