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
  readonly pendingConnectType$: Computed<ConnectorRef | null>;
  readonly setPendingConnectType$: Command<void, [ConnectorRef | null]>;
  readonly selectedConnectType$: Computed<ConnectorRef | null>;
  readonly setSelectedConnectType$: Command<void, [ConnectorRef | null]>;
  readonly savingType$: Computed<ConnectorRef | null>;
  readonly setSavingType$: Command<void, [ConnectorRef | null]>;
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
  readonly permissionConnector$: Computed<ConnectorRef | null>;
  readonly setPermissionConnector$: Command<void, [ConnectorRef | null]>;
  readonly permissionMetadata$: Computed<
    Promise<PublicConnectorCatalogPermissionDetail | null>
  >;
  readonly permissionGrants$: Computed<
    Promise<readonly UserPermissionGrantResponse[]>
  >;
}

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
  readonly pendingConnectType: ConnectorRef | null;
  readonly selectedConnectType: ConnectorRef | null;
  readonly savingType: ConnectorRef | null;
  readonly addDialogSearch: string;
  readonly popoverSearch: string;
  readonly popoverSortOrder: readonly ConnectorRef[] | null;
  readonly computerUseDownloadDialogOpen: boolean;
  readonly permissionConnector: ConnectorRef | null;
}

function initialComposerConnectorUiState(): ComposerConnectorUiState {
  return {
    showAddDialog: false,
    pendingConnectType: null,
    selectedConnectType: null,
    savingType: null,
    addDialogSearch: "",
    popoverSearch: "",
    popoverSortOrder: null,
    computerUseDownloadDialogOpen: false,
    permissionConnector: null,
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
      connectorType: ConnectorRef,
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
            body: { enabledTypes: [connectorType], operation },
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
      connectorType: ConnectorRef,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(updateAuthorizedConnectors$, "add", connectorType, signal);
    },
  );

  const deauthorizeConnector$ = command(
    async (
      { set },
      connectorType: ConnectorRef,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(updateAuthorizedConnectors$, "remove", connectorType, signal);
    },
  );

  return {
    authorizedConnectors$,
    authorizeConnector$,
    deauthorizeConnector$,
  };
}

export function createComposerConnectorSignals(
  agentId$: Computed<Promise<string | null>>,
): ComposerConnectorSignals {
  const authorization = createConnectorAuthorizationSignals(agentId$);
  const initial = initialComposerConnectorUiState();
  const showAddDialog = createStateBinding(initial.showAddDialog);
  const pendingConnectType = createStateBinding(initial.pendingConnectType);
  const selectedConnectType = createStateBinding(initial.selectedConnectType);
  const savingType = createStateBinding(initial.savingType);
  const addDialogSearch = createStateBinding(initial.addDialogSearch);
  const popoverSearch = createStateBinding(initial.popoverSearch);
  const popoverSortOrder = createStateBinding(initial.popoverSortOrder);
  const computerUseDownloadDialogOpen = createStateBinding(
    initial.computerUseDownloadDialogOpen,
  );
  const permissionConnector = createStateBinding(initial.permissionConnector);

  const permissionMetadata$ = computed(async (get) => {
    const connectorType = get(permissionConnector.value$);
    if (!connectorType) {
      return null;
    }
    return await get(
      firewallPermissionMetadataByConnector({ connectorRef: connectorType }),
    );
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
    pendingConnectType$: pendingConnectType.value$,
    setPendingConnectType$: pendingConnectType.set$,
    selectedConnectType$: selectedConnectType.value$,
    setSelectedConnectType$: selectedConnectType.set$,
    savingType$: savingType.value$,
    setSavingType$: savingType.set$,
    addDialogSearch$: addDialogSearch.value$,
    setAddDialogSearch$: addDialogSearch.set$,
    popoverSearch$: popoverSearch.value$,
    setPopoverSearch$: popoverSearch.set$,
    popoverSortOrder$: popoverSortOrder.value$,
    setPopoverSortOrder$: popoverSortOrder.set$,
    computerUseDownloadDialogOpen$: computerUseDownloadDialogOpen.value$,
    setComputerUseDownloadDialogOpen$: computerUseDownloadDialogOpen.set$,
    permissionConnector$: permissionConnector.value$,
    setPermissionConnector$: permissionConnector.set$,
    permissionMetadata$,
    permissionGrants$,
  };
}
