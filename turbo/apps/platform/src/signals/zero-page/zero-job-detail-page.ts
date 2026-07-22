import { command, computed, state } from "ccstate";
import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";

// ---------------------------------------------------------------------------
// JobPermissionsTab UI state
// ---------------------------------------------------------------------------

const internalConnectorRef$ = state<ConnectorRef | null>(null);
export const permConnectorRef$ = computed((get) => {
  return get(internalConnectorRef$);
});
export const setPermConnectorRef$ = command(
  ({ set }, connectorRef: ConnectorRef | null) => {
    set(internalConnectorRef$, connectorRef);
  },
);

export const agentPermissionMetadata$ = computed(async (get) => {
  const connectorRef = get(permConnectorRef$);
  if (!connectorRef) {
    return null;
  }
  return await get(firewallPermissionMetadataByConnector({ connectorRef }));
});

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

const internalPermSavingRef$ = state<ConnectorRef | null>(null);
export const permSavingRef$ = computed((get) => {
  return get(internalPermSavingRef$);
});
export const setPermSavingRef$ = command(
  ({ set }, connectorRef: ConnectorRef | null) => {
    set(internalPermSavingRef$, connectorRef);
  },
);
