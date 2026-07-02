import { command, computed, state, type Computed } from "ccstate";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroClient$ } from "../../api-client.ts";
import { agents$ } from "../../agent.ts";
import { ApiError, accept } from "../../../lib/accept.ts";
import { userPermissionGrantsByAgent } from "../../permission-allow/permission-allow-signals.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "../agent-connector-authorizations.ts";
import { settle } from "../../utils.ts";

export interface ConnectorAgentAccessRow {
  readonly agent: TeamComposeItem;
  readonly authorized: boolean;
  readonly grants: readonly UserPermissionGrantResponse[];
}

interface ConnectorAgentAuthorizationRow {
  readonly agent: TeamComposeItem;
  readonly enabledTypes: readonly string[];
}

interface ConnectorAgentAccessRowsParams {
  readonly connectorType: ConnectorType;
}

interface SetConnectorAgentAuthorizationParams {
  readonly agentId: string;
  readonly connectorType: ConnectorType;
  readonly authorized: boolean;
}

const managedConnectorAccessTypeState$ = state<ConnectorType | null>(null);
const connectorAccessManagementSearchState$ = state("");
const connectorAccessManagementSavingAgentIdState$ = state<string | null>(null);
const connectorAccessManagementPermissionAgentIdState$ = state<string | null>(
  null,
);

export const managedConnectorAccessType$ = computed((get) => {
  return get(managedConnectorAccessTypeState$);
});

export const connectorAccessManagementSearch$ = computed((get) => {
  return get(connectorAccessManagementSearchState$);
});

export const connectorAccessManagementSavingAgentId$ = computed((get) => {
  return get(connectorAccessManagementSavingAgentIdState$);
});

export const connectorAccessManagementPermissionAgentId$ = computed((get) => {
  return get(connectorAccessManagementPermissionAgentIdState$);
});

export const setManagedConnectorAccessType$ = command(
  ({ set }, connectorType: ConnectorType | null) => {
    set(managedConnectorAccessTypeState$, connectorType);
  },
);

export const closeConnectorAccessManagement$ = command(({ set }) => {
  set(managedConnectorAccessTypeState$, null);
  set(connectorAccessManagementSearchState$, "");
  set(connectorAccessManagementSavingAgentIdState$, null);
  set(connectorAccessManagementPermissionAgentIdState$, null);
});

export const setConnectorAccessManagementSearch$ = command(
  ({ set }, search: string) => {
    set(connectorAccessManagementSearchState$, search);
  },
);

export const setConnectorAccessManagementSavingAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(connectorAccessManagementSavingAgentIdState$, agentId);
  },
);

export const setConnectorAccessManagementPermissionAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(connectorAccessManagementPermissionAgentIdState$, agentId);
  },
);

export const connectorAgentAuthorizations$ = computed(
  async (get): Promise<readonly ConnectorAgentAuthorizationRow[]> => {
    const allAgents = await get(agents$);
    const rows = await Promise.all(
      allAgents.map(
        async (agent): Promise<ConnectorAgentAuthorizationRow | null> => {
          const authorizations = await get(
            agentConnectorAuthorizations({
              agentId: agent.id,
              missing: "null",
            }),
          );
          if (!authorizations) {
            return null;
          }
          return {
            agent,
            enabledTypes: authorizations.enabledTypes,
          };
        },
      ),
    );
    return rows.filter((row): row is ConnectorAgentAuthorizationRow => {
      return row !== null;
    });
  },
);

function createConnectorAuthorizedAgentsFactory(): (
  params: ConnectorAgentAccessRowsParams,
) => Computed<Promise<readonly TeamComposeItem[]>> {
  const cache = new Map<
    string,
    Computed<Promise<readonly TeamComposeItem[]>>
  >();
  return (params) => {
    const existing = cache.get(params.connectorType);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get): Promise<readonly TeamComposeItem[]> => {
      const authorizations = await get(connectorAgentAuthorizations$);
      return authorizations
        .filter((row) => {
          return row.enabledTypes.includes(params.connectorType);
        })
        .map((row) => {
          return row.agent;
        });
    });
    cache.set(params.connectorType, atom$);
    return atom$;
  };
}

function createConnectorAgentAccessRowsFactory(): (
  params: ConnectorAgentAccessRowsParams,
) => Computed<Promise<readonly ConnectorAgentAccessRow[]>> {
  const cache = new Map<
    string,
    Computed<Promise<readonly ConnectorAgentAccessRow[]>>
  >();
  return (params) => {
    const existing = cache.get(params.connectorType);
    if (existing) {
      return existing;
    }
    const atom$ = computed(
      async (get): Promise<readonly ConnectorAgentAccessRow[]> => {
        const authorizations = await get(connectorAgentAuthorizations$);
        const rows = await Promise.all(
          authorizations.map(
            async ({
              agent,
              enabledTypes,
            }): Promise<ConnectorAgentAccessRow | null> => {
              const authorized = enabledTypes.includes(params.connectorType);
              let grants: readonly UserPermissionGrantResponse[] = [];
              if (authorized) {
                const grantsResult = await settle(
                  get(userPermissionGrantsByAgent({ agentId: agent.id })),
                );
                if (!grantsResult.ok) {
                  if (
                    grantsResult.error instanceof ApiError &&
                    grantsResult.error.status === 404
                  ) {
                    return null;
                  }
                  throw grantsResult.error;
                }
                grants = grantsResult.value;
              }
              return {
                agent,
                authorized,
                grants,
              };
            },
          ),
        );
        return rows.filter((row): row is ConnectorAgentAccessRow => {
          return row !== null;
        });
      },
    );
    cache.set(params.connectorType, atom$);
    return atom$;
  };
}

export const connectorAuthorizedAgents =
  createConnectorAuthorizedAgentsFactory();

export const connectorAgentAccessRows = createConnectorAgentAccessRowsFactory();

export const setConnectorAgentAuthorization$ = command(
  async (
    { get, set },
    params: SetConnectorAgentAuthorizationParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroUserConnectorsContract);
    await accept(
      client.update({
        params: { id: params.agentId },
        body: {
          enabledTypes: [params.connectorType],
          operation: params.authorized ? "add" : "remove",
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(reloadAgentConnectorAuthorizations$);
  },
);
