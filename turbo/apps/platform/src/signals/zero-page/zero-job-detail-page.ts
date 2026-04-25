import { command, computed, state } from "ccstate";
import type { ConnectorType } from "@vm0/api-contracts/contracts/connectors";

// ---------------------------------------------------------------------------
// JobPermissionsTab UI state
// ---------------------------------------------------------------------------

const internalConnectorType$ = state<ConnectorType | null>(null);
export const permConnectorType$ = computed((get) => {
  return get(internalConnectorType$);
});
export const setPermConnectorType$ = command(
  ({ set }, type: ConnectorType | null) => {
    set(internalConnectorType$, type);
  },
);

const internalPermSearch$ = state("");
export const permSearch$ = computed((get) => {
  return get(internalPermSearch$);
});
export const setPermSearch$ = command(({ set }, value: string) => {
  set(internalPermSearch$, value);
});

const internalPermSearchActive$ = state(false);
export const permSearchActive$ = computed((get) => {
  return get(internalPermSearchActive$);
});
export const setPermSearchActive$ = command(({ set }, active: boolean) => {
  set(internalPermSearchActive$, active);
});

const internalPermSavingType$ = state<string | null>(null);
export const permSavingType$ = computed((get) => {
  return get(internalPermSavingType$);
});
export const setPermSavingType$ = command(({ set }, type: string | null) => {
  set(internalPermSavingType$, type);
});
