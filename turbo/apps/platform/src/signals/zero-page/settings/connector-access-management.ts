import { command, computed, state } from "ccstate";
import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroClient$ } from "../../api-client.ts";
import { agents$ } from "../../agent.ts";
import { accept } from "../../../lib/accept.ts";
import { userPermissionGrantsByAgentIfExists } from "../../permission-allow/permission-allow-signals.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "../agent-connector-authorizations.ts";
import { withCleanup } from "../../utils.ts";
import { firewallPermissionMetadataByConnector } from "../../firewall-permission-metadata.ts";

export interface ConnectorAgentAccessRow {
  readonly agent: TeamComposeItem;
  readonly authorized: boolean;
  readonly grants: readonly UserPermissionGrantResponse[];
}

interface ConnectorAgentAuthorizationRow {
  readonly agent: TeamComposeItem;
  readonly enabledTypes: readonly ConnectorRef[];
}

interface SetConnectorAgentAuthorizationParams {
  readonly agentId: string;
  readonly connectorRef: ConnectorRef;
  readonly authorized: boolean;
}

const managedConnectorAccessRefState$ = state<ConnectorRef | null>(null);
const connectorAccessManagementSearchState$ = state("");
const connectorAccessManagementSavingAgentIdState$ = state<string | null>(null);
const connectorAccessManagementPermissionAgentIdState$ = state<string | null>(
  null,
);

export const managedConnectorAccessRef$ = computed((get) => {
  return get(managedConnectorAccessRefState$);
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

export const setManagedConnectorAccessRef$ = command(
  ({ set }, connectorRef: ConnectorRef | null) => {
    set(managedConnectorAccessRefState$, connectorRef);
  },
);

export const closeConnectorAccessManagement$ = command(({ set }) => {
  set(managedConnectorAccessRefState$, null);
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

export const connectorAuthorizedAgentsByRef$ = computed(
  async (
    get,
  ): Promise<ReadonlyMap<ConnectorRef, readonly TeamComposeItem[]>> => {
    const authorizations = await get(connectorAgentAuthorizations$);
    const agentsByRef = new Map<ConnectorRef, TeamComposeItem[]>();
    for (const row of authorizations) {
      for (const connectorRef of row.enabledTypes) {
        const agents = agentsByRef.get(connectorRef) ?? [];
        agents.push(row.agent);
        agentsByRef.set(connectorRef, agents);
      }
    }
    return agentsByRef;
  },
);

export const managedConnectorAgentAccessRows$ = computed(
  async (get): Promise<readonly ConnectorAgentAccessRow[]> => {
    const connectorRef = get(managedConnectorAccessRef$);
    if (!connectorRef) {
      return [];
    }
    const authorizations = await get(connectorAgentAuthorizations$);
    const rows = await Promise.all(
      authorizations.map(
        async ({
          agent,
          enabledTypes,
        }): Promise<ConnectorAgentAccessRow | null> => {
          const authorized = enabledTypes.includes(connectorRef);
          let grants: readonly UserPermissionGrantResponse[] = [];
          if (authorized) {
            const loadedGrants = await get(
              userPermissionGrantsByAgentIfExists({ agentId: agent.id }),
            );
            if (loadedGrants === null) {
              return null;
            }
            grants = loadedGrants;
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

export const managedConnectorFirewallPermissionMetadata$ = computed(
  async (get) => {
    const connectorRef = get(managedConnectorAccessRef$);
    if (!connectorRef) {
      return null;
    }
    return await get(firewallPermissionMetadataByConnector({ connectorRef }));
  },
);

export const setConnectorAgentAuthorization$ = command(
  async (
    { get, set },
    params: SetConnectorAgentAuthorizationParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroUserConnectorsContract);
    await withCleanup(
      accept(
        client.update({
          params: { id: params.agentId },
          body: {
            enabledTypes: [params.connectorRef],
            operation: params.authorized ? "add" : "remove",
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
  },
);
