import { command, computed, state } from "ccstate";
import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";

// ---------------------------------------------------------------------------
// JobPermissionsTab UI state
// ---------------------------------------------------------------------------

const internalConnectorType$ = state<ConnectorRef | null>(null);
export const permConnectorType$ = computed((get) => {
  return get(internalConnectorType$);
});
export const setPermConnectorType$ = command(
  ({ set }, type: ConnectorRef | null) => {
    set(internalConnectorType$, type);
  },
);

export const agentPermissionMetadata$ = computed(async (get) => {
  const connectorType = get(permConnectorType$);
  if (!connectorType) {
    return null;
  }
  return await get(
    firewallPermissionMetadataByConnector({ connectorRef: connectorType }),
  );
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

const internalPermSavingType$ = state<string | null>(null);
export const permSavingType$ = computed((get) => {
  return get(internalPermSavingType$);
});
export const setPermSavingType$ = command(({ set }, type: string | null) => {
  set(internalPermSavingType$, type);
});
