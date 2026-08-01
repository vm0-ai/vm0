import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { userPermissionGrantsByAgent } from "../permission-allow/permission-allow-signals.ts";
import { withCleanup } from "../utils.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "./agent-connector-authorizations.ts";
import { reloadOnboardingStatus$ } from "./zero-onboarding.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";
import {
  customConnectorAuthorizationReloadVersion$,
  reloadCustomConnectorAuthorizedAgents$,
} from "./settings/custom-connectors.ts";

export interface ComposerConnectorAuthorizationState {
  readonly agentId: string;
  readonly enabledConnectorSlugs: readonly ConnectorSlug[];
  readonly enabledCustomConnectorIds: readonly string[];
}

export type ComposerConnectorAuthorizationTarget =
  | {
      readonly kind: "builtin";
      readonly connectorSlug: ConnectorSlug;
    }
  | {
      readonly kind: "custom";
      readonly connectorId: string;
    };

export interface ComposerConnectorUiState {
  readonly showAddDialog: boolean;
  readonly pendingConnectorSlug: ConnectorSlug | null;
  readonly selectedConnectorSlug: ConnectorSlug | null;
  readonly savingConnectorSlug: ConnectorSlug | null;
  readonly selectedCustomConnectorId: string | null;
  readonly savingCustomConnectorId: string | null;
  readonly addDialogSearch: string;
  readonly popoverSearch: string;
  readonly popoverSortOrder: readonly string[] | null;
  readonly permissionConnectorSlug: ConnectorSlug | null;
}

interface ComposerConnectorSignals {
  readonly connectorAuthorization$: Computed<
    Promise<ComposerConnectorAuthorizationState>
  >;
  readonly setConnectorAuthorization$: Command<
    Promise<void>,
    [ComposerConnectorAuthorizationTarget, boolean, AbortSignal]
  >;
  readonly connectorUiState$: Computed<ComposerConnectorUiState>;
  readonly updateConnectorUiState$: Command<
    void,
    [Partial<ComposerConnectorUiState>]
  >;
  readonly connectorPermissionMetadata$: Computed<
    Promise<PlatformConnectorPermissionMetadata | null>
  >;
  readonly connectorPermissionGrants$: Computed<
    Promise<readonly PlatformUserPermissionGrant[]>
  >;
}

interface AgentCustomConnectorAuthorizationRequestBroker {
  load(params: {
    readonly createClient: ZeroClientFactory;
    readonly agentId: string;
    readonly reloadGeneration: number;
  }): Promise<readonly string[]>;
}

interface ResolvedAgentCustomConnectorAuthorizationRequest {
  readonly key: string;
  readonly value: readonly string[];
}

function agentCustomConnectorAuthorizationRequestKey(params: {
  readonly agentId: string;
  readonly reloadGeneration: number;
}): string {
  return JSON.stringify([params.reloadGeneration, params.agentId]);
}

function createAgentCustomConnectorAuthorizationRequestBroker(): AgentCustomConnectorAuthorizationRequestBroker {
  const pendingRequestsByClient = new WeakMap<
    ZeroClientFactory,
    Map<string, Promise<readonly string[]>>
  >();
  const latestRequestedKeyByClient = new WeakMap<ZeroClientFactory, string>();
  const latestResolvedByClient = new WeakMap<
    ZeroClientFactory,
    ResolvedAgentCustomConnectorAuthorizationRequest
  >();

  return {
    load(params) {
      const key = agentCustomConnectorAuthorizationRequestKey(params);
      latestRequestedKeyByClient.set(params.createClient, key);
      const resolved = latestResolvedByClient.get(params.createClient);
      if (resolved?.key === key) {
        return Promise.resolve(resolved.value);
      }
      let pendingRequests = pendingRequestsByClient.get(params.createClient);
      if (!pendingRequests) {
        pendingRequests = new Map();
        pendingRequestsByClient.set(params.createClient, pendingRequests);
      }
      const pendingRequest = pendingRequests.get(key);
      if (pendingRequest) {
        return pendingRequest;
      }

      const load = async (): Promise<readonly string[]> => {
        const client = params.createClient(zeroAgentCustomConnectorsContract);
        const result = await accept(
          client.get({ params: { id: params.agentId } }),
          [200],
        );
        const value = result.body.enabledIds;
        if (latestRequestedKeyByClient.get(params.createClient) === key) {
          latestResolvedByClient.set(params.createClient, { key, value });
        }
        return value;
      };
      const sharedRequest = withCleanup(load(), () => {
        pendingRequests.delete(key);
        if (pendingRequests.size === 0) {
          pendingRequestsByClient.delete(params.createClient);
        }
      });
      pendingRequests.set(key, sharedRequest);
      return sharedRequest;
    },
  };
}

const agentCustomConnectorAuthorizationRequestBroker$ = computed(() => {
  return createAgentCustomConnectorAuthorizationRequestBroker();
});

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
    permissionConnectorSlug: null,
  };
}

function createAgentIdSignal(
  agent$: Computed<Promise<ZeroAgentResponse>>,
): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    return (await get(agent$)).agentId;
  });
}

function createConnectorAuthorizationSignal(
  agentId$: Computed<Promise<string>>,
): Computed<Promise<ComposerConnectorAuthorizationState>> {
  const authorizations$ = computed(async (get) => {
    const agentId = await get(agentId$);
    return await get(agentConnectorAuthorizations({ agentId }));
  });
  const customAuthorizations$ = computed(async (get) => {
    const agentId = await get(agentId$);
    const reloadGeneration = get(customConnectorAuthorizationReloadVersion$);
    return await get(agentCustomConnectorAuthorizationRequestBroker$).load({
      createClient: get(zeroClient$),
      agentId,
      reloadGeneration,
    });
  });

  return computed(async (get): Promise<ComposerConnectorAuthorizationState> => {
    const [authorizations, enabledCustomConnectorIds] = await Promise.all([
      get(authorizations$),
      get(customAuthorizations$),
    ]);
    return {
      agentId: authorizations.agentId,
      enabledConnectorSlugs: authorizations.enabledConnectorSlugs,
      enabledCustomConnectorIds,
    };
  });
}

function createBuiltinConnectorAuthorizationCommand(
  agentId$: Computed<Promise<string>>,
): Command<Promise<void>, [ConnectorSlug, boolean, AbortSignal]> {
  return command(
    async (
      { get, set },
      connectorSlug: ConnectorSlug,
      authorized: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const agentId = await get(agentId$);
      signal.throwIfAborted();
      const client = get(zeroClient$)(zeroUserConnectorsContract);
      await withCleanup(
        accept(
          client.update({
            params: { id: agentId },
            body: {
              enabledConnectorSlugs: [connectorSlug],
              operation: authorized ? "add" : "remove",
            },
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
}

function createCustomConnectorAuthorizationCommand(
  agentId$: Computed<Promise<string>>,
): Command<Promise<void>, [string, boolean, AbortSignal]> {
  return command(
    async (
      { get, set },
      connectorId: string,
      authorized: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const agentId = await get(agentId$);
      signal.throwIfAborted();
      const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
      await withCleanup(
        accept(
          client.update({
            params: { id: agentId },
            body: {
              enabledIds: [connectorId],
              operation: authorized ? "add" : "remove",
            },
            fetchOptions: { signal },
          }),
          [200],
        ),
        () => {
          set(reloadCustomConnectorAuthorizedAgents$);
        },
      );
    },
  );
}

function createConnectorAuthorizationCommand(
  agentId$: Computed<Promise<string>>,
): ComposerConnectorSignals["setConnectorAuthorization$"] {
  const setBuiltinAuthorization$ =
    createBuiltinConnectorAuthorizationCommand(agentId$);
  const setCustomAuthorization$ =
    createCustomConnectorAuthorizationCommand(agentId$);
  return command(
    async (
      { set },
      target: ComposerConnectorAuthorizationTarget,
      authorized: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      if (target.kind === "builtin") {
        await set(
          setBuiltinAuthorization$,
          target.connectorSlug,
          authorized,
          signal,
        );
        return;
      }
      await set(
        setCustomAuthorization$,
        target.connectorId,
        authorized,
        signal,
      );
    },
  );
}

function createConnectorUiSignals(): Pick<
  ComposerConnectorSignals,
  "connectorUiState$" | "updateConnectorUiState$"
> {
  const internalUiState$ = state(initialComposerConnectorUiState());
  const connectorUiState$ = computed((get): ComposerConnectorUiState => {
    return get(internalUiState$);
  });
  const updateConnectorUiState$ = command(
    ({ set }, patch: Partial<ComposerConnectorUiState>): void => {
      set(internalUiState$, (current) => {
        return { ...current, ...patch };
      });
    },
  );
  return { connectorUiState$, updateConnectorUiState$ };
}

export function createComposerConnectorSignals(
  agent$: Computed<Promise<ZeroAgentResponse>>,
): ComposerConnectorSignals {
  const agentId$ = createAgentIdSignal(agent$);
  const ui = createConnectorUiSignals();
  const connectorPermissionMetadata$ = computed(async (get) => {
    const connectorSlug = get(ui.connectorUiState$).permissionConnectorSlug;
    if (!connectorSlug) {
      return null;
    }
    return await get(firewallPermissionMetadataByConnector({ connectorSlug }));
  });
  const connectorPermissionGrants$ = computed(
    async (get): Promise<readonly PlatformUserPermissionGrant[]> => {
      const agentId = await get(agentId$);
      return await get(userPermissionGrantsByAgent({ agentId }));
    },
  );

  return {
    connectorAuthorization$: createConnectorAuthorizationSignal(agentId$),
    setConnectorAuthorization$: createConnectorAuthorizationCommand(agentId$),
    ...ui,
    connectorPermissionMetadata$,
    connectorPermissionGrants$,
  };
}
