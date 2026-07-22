import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogPermissionDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { userPermissionGrantsByAgent } from "../permission-allow/permission-allow-signals.ts";
import { withCleanup } from "../utils.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "./agent-connector-authorizations.ts";
import { reloadOnboardingStatus$ } from "./zero-onboarding.ts";

export interface ComposerConnectorSignals {
  readonly agentId$: Computed<Promise<string | null>>;
  readonly authorizedConnectors$: Computed<Promise<readonly ConnectorRef[]>>;
  readonly authorizeConnector$: Command<
    Promise<void>,
    [ConnectorRef, AbortSignal]
  >;
  readonly deauthorizeConnector$: Command<
    Promise<void>,
    [ConnectorRef, AbortSignal]
  >;
  readonly showAddDialog$: Computed<boolean>;
  readonly setShowAddDialog$: Command<void, [boolean]>;
  readonly pendingConnectorRef$: Computed<ConnectorRef | null>;
  readonly setPendingConnectorRef$: Command<void, [ConnectorRef | null]>;
  readonly selectedConnectorRef$: Computed<ConnectorRef | null>;
  readonly setSelectedConnectorRef$: Command<void, [ConnectorRef | null]>;
  readonly savingConnectorRef$: Computed<ConnectorRef | null>;
  readonly setSavingConnectorRef$: Command<void, [ConnectorRef | null]>;
  readonly addDialogSearch$: Computed<string>;
  readonly setAddDialogSearch$: Command<void, [string]>;
  readonly popoverSearch$: Computed<string>;
  readonly setPopoverSearch$: Command<void, [string]>;
  readonly popoverSortOrder$: Computed<readonly ConnectorRef[] | null>;
  readonly setPopoverSortOrder$: Command<
    void,
    [readonly ConnectorRef[] | null]
  >;
  readonly computerUseDownloadDialogOpen$: Computed<boolean>;
  readonly setComputerUseDownloadDialogOpen$: Command<void, [boolean]>;
  readonly permissionConnectorRef$: Computed<ConnectorRef | null>;
  readonly setPermissionConnectorRef$: Command<void, [ConnectorRef | null]>;
  readonly permissionMetadata$: Computed<
    Promise<PublicConnectorCatalogPermissionDetail | null>
  >;
  readonly permissionGrants$: Computed<
    Promise<readonly UserPermissionGrantResponse[]>
  >;
}

type AgentIdValue = string | null | Promise<string | null>;

function createStateBinding<T>(initialValue: T) {
  const internal$ = state(initialValue);
  return {
    value$: computed((get) => {
      return get(internal$);
    }),
    set$: command(({ set }, value: T) => {
      set(internal$, value);
    }),
  };
}

interface ComposerConnectorUiState {
  readonly showAddDialog: boolean;
  readonly pendingConnectorRef: ConnectorRef | null;
  readonly selectedConnectorRef: ConnectorRef | null;
  readonly savingConnectorRef: ConnectorRef | null;
  readonly addDialogSearch: string;
  readonly popoverSearch: string;
  readonly popoverSortOrder: readonly ConnectorRef[] | null;
  readonly computerUseDownloadDialogOpen: boolean;
  readonly permissionConnectorRef: ConnectorRef | null;
}

function initialComposerConnectorUiState(): ComposerConnectorUiState {
  return {
    showAddDialog: false,
    pendingConnectorRef: null,
    selectedConnectorRef: null,
    savingConnectorRef: null,
    addDialogSearch: "",
    popoverSearch: "",
    popoverSortOrder: null,
    computerUseDownloadDialogOpen: false,
    permissionConnectorRef: null,
  };
}

type ConnectorAuthorizationSignals = Pick<
  ComposerConnectorSignals,
  "authorizedConnectors$" | "authorizeConnector$" | "deauthorizeConnector$"
>;

function createConnectorAuthorizationSignals(
  agentId$: Computed<Promise<string | null>>,
): ConnectorAuthorizationSignals {
  const authorizedConnectors$ = computed(
    async (get): Promise<readonly ConnectorRef[]> => {
      const agentId = await get(agentId$);
      if (!agentId) {
        return [];
      }
      const authorizations = await get(
        agentConnectorAuthorizations({ agentId }),
      );
      return authorizations.enabledTypes;
    },
  );

  const updateAuthorizedConnectors$ = command(
    async (
      { get, set },
      operation: "add" | "remove",
      connectorRef: ConnectorRef,
      signal: AbortSignal,
    ): Promise<void> => {
      const agentId = await get(agentId$);
      signal.throwIfAborted();
      if (!agentId) {
        throw new Error("No agent available");
      }

      const client = get(zeroClient$)(zeroUserConnectorsContract);
      await withCleanup(
        accept(
          client.update({
            params: { id: agentId },
            body: { enabledTypes: [connectorRef], operation },
            fetchOptions: { signal },
          }),
          [200],
        ),
        () => {
          set(reloadAgentConnectorAuthorizations$);
        },
      );
      signal.throwIfAborted();

      await set(reloadOnboardingStatus$);
      signal.throwIfAborted();
    },
  );

  const authorizeConnector$ = command(
    async (
      { set },
      connectorRef: ConnectorRef,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(updateAuthorizedConnectors$, "add", connectorRef, signal);
    },
  );

  const deauthorizeConnector$ = command(
    async (
      { set },
      connectorRef: ConnectorRef,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(updateAuthorizedConnectors$, "remove", connectorRef, signal);
    },
  );

  return {
    authorizedConnectors$,
    authorizeConnector$,
    deauthorizeConnector$,
  };
}

export function createComposerConnectorSignals<T extends AgentIdValue>(
  agentIdSource$: Computed<T>,
): ComposerConnectorSignals {
  const agentId$ = computed(async (get): Promise<string | null> => {
    return await get(agentIdSource$);
  });
  const authorization = createConnectorAuthorizationSignals(agentId$);
  const initial = initialComposerConnectorUiState();
  const showAddDialog = createStateBinding(initial.showAddDialog);
  const pendingConnectorRef = createStateBinding(initial.pendingConnectorRef);
  const selectedConnectorRef = createStateBinding(initial.selectedConnectorRef);
  const savingConnectorRef = createStateBinding(initial.savingConnectorRef);
  const addDialogSearch = createStateBinding(initial.addDialogSearch);
  const popoverSearch = createStateBinding(initial.popoverSearch);
  const popoverSortOrder = createStateBinding(initial.popoverSortOrder);
  const computerUseDownloadDialogOpen = createStateBinding(
    initial.computerUseDownloadDialogOpen,
  );
  const permissionConnectorRef = createStateBinding(
    initial.permissionConnectorRef,
  );

  const permissionMetadata$ = computed(async (get) => {
    const connectorRef = get(permissionConnectorRef.value$);
    if (!connectorRef) {
      return null;
    }
    return await get(firewallPermissionMetadataByConnector({ connectorRef }));
  });
  const permissionGrants$ = computed(
    async (get): Promise<readonly UserPermissionGrantResponse[]> => {
      const agentId = await get(agentId$);
      if (!agentId) {
        return [];
      }
      return await get(userPermissionGrantsByAgent({ agentId }));
    },
  );

  return {
    agentId$,
    ...authorization,
    showAddDialog$: showAddDialog.value$,
    setShowAddDialog$: showAddDialog.set$,
    pendingConnectorRef$: pendingConnectorRef.value$,
    setPendingConnectorRef$: pendingConnectorRef.set$,
    selectedConnectorRef$: selectedConnectorRef.value$,
    setSelectedConnectorRef$: selectedConnectorRef.set$,
    savingConnectorRef$: savingConnectorRef.value$,
    setSavingConnectorRef$: savingConnectorRef.set$,
    addDialogSearch$: addDialogSearch.value$,
    setAddDialogSearch$: addDialogSearch.set$,
    popoverSearch$: popoverSearch.value$,
    setPopoverSearch$: popoverSearch.set$,
    popoverSortOrder$: popoverSortOrder.value$,
    setPopoverSortOrder$: popoverSortOrder.set$,
    computerUseDownloadDialogOpen$: computerUseDownloadDialogOpen.value$,
    setComputerUseDownloadDialogOpen$: computerUseDownloadDialogOpen.set$,
    permissionConnectorRef$: permissionConnectorRef.value$,
    setPermissionConnectorRef$: permissionConnectorRef.set$,
    permissionMetadata$,
    permissionGrants$,
  };
}
