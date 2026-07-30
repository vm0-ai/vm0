import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogPermissionDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { userPermissionGrantsByAgent } from "../permission-allow/permission-allow-signals.ts";
import { withCleanup } from "../utils.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
  type AgentConnectorAuthorizations,
} from "./agent-connector-authorizations.ts";
import { reloadOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  customConnectorAuthorizationReloadVersion$,
  reloadCustomConnectorAuthorizedAgents$,
} from "./settings/custom-connectors.ts";

export interface AgentCustomConnectorAuthorizations {
  readonly agentId: string;
  readonly enabledIds: readonly string[];
}

export interface ComposerConnectorAuthorizationSignals {
  readonly agentId$: Computed<Promise<string | null>>;
  readonly authorizations$: Computed<
    Promise<AgentConnectorAuthorizations | null>
  >;
  readonly customAuthorizations$: Computed<
    Promise<AgentCustomConnectorAuthorizations | null>
  >;
}

export interface ComposerConnectorSignals extends ComposerConnectorAuthorizationSignals {
  readonly authorizeConnector$: Command<
    Promise<void>,
    [ConnectorSlug, AbortSignal]
  >;
  readonly deauthorizeConnector$: Command<
    Promise<void>,
    [ConnectorSlug, AbortSignal]
  >;
  readonly authorizeCustomConnector$: Command<
    Promise<void>,
    [string, AbortSignal]
  >;
  readonly deauthorizeCustomConnector$: Command<
    Promise<void>,
    [string, AbortSignal]
  >;
  readonly showAddDialog$: Computed<boolean>;
  readonly setShowAddDialog$: Command<void, [boolean]>;
  readonly pendingConnectorSlug$: Computed<ConnectorSlug | null>;
  readonly setPendingConnectorSlug$: Command<void, [ConnectorSlug | null]>;
  readonly selectedConnectorSlug$: Computed<ConnectorSlug | null>;
  readonly setSelectedConnectorSlug$: Command<void, [ConnectorSlug | null]>;
  readonly savingConnectorSlug$: Computed<ConnectorSlug | null>;
  readonly setSavingConnectorSlug$: Command<void, [ConnectorSlug | null]>;
  readonly selectedCustomConnectorId$: Computed<string | null>;
  readonly setSelectedCustomConnectorId$: Command<void, [string | null]>;
  readonly savingCustomConnectorId$: Computed<string | null>;
  readonly setSavingCustomConnectorId$: Command<void, [string | null]>;
  readonly addDialogSearch$: Computed<string>;
  readonly setAddDialogSearch$: Command<void, [string]>;
  readonly popoverSearch$: Computed<string>;
  readonly setPopoverSearch$: Command<void, [string]>;
  readonly popoverSortOrder$: Computed<readonly string[] | null>;
  readonly setPopoverSortOrder$: Command<void, [readonly string[] | null]>;
  readonly computerUseDownloadDialogOpen$: Computed<boolean>;
  readonly setComputerUseDownloadDialogOpen$: Command<void, [boolean]>;
  readonly permissionConnectorSlug$: Computed<ConnectorSlug | null>;
  readonly setPermissionConnectorSlug$: Command<void, [ConnectorSlug | null]>;
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
  readonly pendingConnectorSlug: ConnectorSlug | null;
  readonly selectedConnectorSlug: ConnectorSlug | null;
  readonly savingConnectorSlug: ConnectorSlug | null;
  readonly selectedCustomConnectorId: string | null;
  readonly savingCustomConnectorId: string | null;
  readonly addDialogSearch: string;
  readonly popoverSearch: string;
  readonly popoverSortOrder: readonly string[] | null;
  readonly computerUseDownloadDialogOpen: boolean;
  readonly permissionConnectorSlug: ConnectorSlug | null;
}

function initialComposerConnectorUiState(): ComposerConnectorUiState {
  return {
    showAddDialog: false,
    pendingConnectorSlug: null,
    selectedConnectorSlug: null,
    savingConnectorSlug: null,
    selectedCustomConnectorId: null,
    savingCustomConnectorId: null,
    addDialogSearch: "",
    popoverSearch: "",
    popoverSortOrder: null,
    computerUseDownloadDialogOpen: false,
    permissionConnectorSlug: null,
  };
}

export function createComposerConnectorAuthorizationSignals<
  T extends AgentIdValue,
>(agentIdSource$: Computed<T>): ComposerConnectorAuthorizationSignals {
  const agentId$ = computed(async (get): Promise<string | null> => {
    return await get(agentIdSource$);
  });
  const authorizations$ = computed(
    async (get): Promise<AgentConnectorAuthorizations | null> => {
      const agentId = await get(agentId$);
      if (!agentId) {
        return null;
      }
      return await get(agentConnectorAuthorizations({ agentId }));
    },
  );
  const customAuthorizations$ = computed(
    async (get): Promise<AgentCustomConnectorAuthorizations | null> => {
      const agentId = await get(agentId$);
      if (!agentId) {
        return null;
      }
      get(customConnectorAuthorizationReloadVersion$);
      const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
      const result = await accept(
        client.get({ params: { id: agentId } }),
        [200],
      );
      return {
        agentId,
        enabledIds: result.body.enabledIds,
      };
    },
  );
  return { agentId$, authorizations$, customAuthorizations$ };
}

function createConnectorAuthorizationCommands(
  agentId$: Computed<Promise<string | null>>,
): Pick<
  ComposerConnectorSignals,
  "authorizeConnector$" | "deauthorizeConnector$"
> {
  const updateAuthorizedConnectors$ = command(
    async (
      { get, set },
      operation: "add" | "remove",
      connectorSlug: ConnectorSlug,
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
            body: { enabledTypes: [connectorSlug], operation },
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
      connectorSlug: ConnectorSlug,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(updateAuthorizedConnectors$, "add", connectorSlug, signal);
    },
  );

  const deauthorizeConnector$ = command(
    async (
      { set },
      connectorSlug: ConnectorSlug,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(updateAuthorizedConnectors$, "remove", connectorSlug, signal);
    },
  );

  return {
    authorizeConnector$,
    deauthorizeConnector$,
  };
}

function createCustomConnectorAuthorizationCommands(
  agentId$: Computed<Promise<string | null>>,
): Pick<
  ComposerConnectorSignals,
  "authorizeCustomConnector$" | "deauthorizeCustomConnector$"
> {
  const updateAuthorizedCustomConnectors$ = command(
    async (
      { get, set },
      operation: "add" | "remove",
      connectorId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const agentId = await get(agentId$);
      signal.throwIfAborted();
      if (!agentId) {
        throw new Error("No agent available");
      }

      const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
      await withCleanup(
        accept(
          client.update({
            params: { id: agentId },
            body: { enabledIds: [connectorId], operation },
            fetchOptions: { signal },
          }),
          [200],
        ),
        () => {
          set(reloadCustomConnectorAuthorizedAgents$);
        },
      );
      signal.throwIfAborted();
    },
  );

  const authorizeCustomConnector$ = command(
    async (
      { set },
      connectorId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(updateAuthorizedCustomConnectors$, "add", connectorId, signal);
    },
  );

  const deauthorizeCustomConnector$ = command(
    async (
      { set },
      connectorId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(
        updateAuthorizedCustomConnectors$,
        "remove",
        connectorId,
        signal,
      );
    },
  );

  return {
    authorizeCustomConnector$,
    deauthorizeCustomConnector$,
  };
}

export function createComposerConnectorSignals<T extends AgentIdValue>(
  agentIdSource$: Computed<T>,
  authorization?: ComposerConnectorAuthorizationSignals,
): ComposerConnectorSignals {
  const localAgentId$ = computed(async (get): Promise<string | null> => {
    return await get(agentIdSource$);
  });
  const resolvedAuthorization =
    authorization ?? createComposerConnectorAuthorizationSignals(localAgentId$);
  const authorizationCommands =
    createConnectorAuthorizationCommands(localAgentId$);
  const customAuthorizationCommands =
    createCustomConnectorAuthorizationCommands(localAgentId$);
  const initial = initialComposerConnectorUiState();
  const showAddDialog = createStateBinding(initial.showAddDialog);
  const pendingConnectorSlug = createStateBinding(initial.pendingConnectorSlug);
  const selectedConnectorSlug = createStateBinding(
    initial.selectedConnectorSlug,
  );
  const savingConnectorSlug = createStateBinding(initial.savingConnectorSlug);
  const selectedCustomConnectorId = createStateBinding(
    initial.selectedCustomConnectorId,
  );
  const savingCustomConnectorId = createStateBinding(
    initial.savingCustomConnectorId,
  );
  const addDialogSearch = createStateBinding(initial.addDialogSearch);
  const popoverSearch = createStateBinding(initial.popoverSearch);
  const popoverSortOrder = createStateBinding(initial.popoverSortOrder);
  const computerUseDownloadDialogOpen = createStateBinding(
    initial.computerUseDownloadDialogOpen,
  );
  const permissionConnectorSlug = createStateBinding(
    initial.permissionConnectorSlug,
  );

  const permissionMetadata$ = computed(async (get) => {
    const connectorSlug = get(permissionConnectorSlug.value$);
    if (!connectorSlug) {
      return null;
    }
    return await get(firewallPermissionMetadataByConnector({ connectorSlug }));
  });
  const permissionGrants$ = computed(
    async (get): Promise<readonly UserPermissionGrantResponse[]> => {
      const agentId = await get(localAgentId$);
      if (!agentId) {
        return [];
      }
      return await get(userPermissionGrantsByAgent({ agentId }));
    },
  );

  return {
    ...resolvedAuthorization,
    ...authorizationCommands,
    ...customAuthorizationCommands,
    showAddDialog$: showAddDialog.value$,
    setShowAddDialog$: showAddDialog.set$,
    pendingConnectorSlug$: pendingConnectorSlug.value$,
    setPendingConnectorSlug$: pendingConnectorSlug.set$,
    selectedConnectorSlug$: selectedConnectorSlug.value$,
    setSelectedConnectorSlug$: selectedConnectorSlug.set$,
    savingConnectorSlug$: savingConnectorSlug.value$,
    setSavingConnectorSlug$: savingConnectorSlug.set$,
    selectedCustomConnectorId$: selectedCustomConnectorId.value$,
    setSelectedCustomConnectorId$: selectedCustomConnectorId.set$,
    savingCustomConnectorId$: savingCustomConnectorId.value$,
    setSavingCustomConnectorId$: savingCustomConnectorId.set$,
    addDialogSearch$: addDialogSearch.value$,
    setAddDialogSearch$: addDialogSearch.set$,
    popoverSearch$: popoverSearch.value$,
    setPopoverSearch$: popoverSearch.set$,
    popoverSortOrder$: popoverSortOrder.value$,
    setPopoverSortOrder$: popoverSortOrder.set$,
    computerUseDownloadDialogOpen$: computerUseDownloadDialogOpen.value$,
    setComputerUseDownloadDialogOpen$: computerUseDownloadDialogOpen.set$,
    permissionConnectorSlug$: permissionConnectorSlug.value$,
    setPermissionConnectorSlug$: permissionConnectorSlug.set$,
    permissionMetadata$,
    permissionGrants$,
  };
}
