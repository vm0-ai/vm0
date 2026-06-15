import { command, computed, state } from "ccstate";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { zeroClient$ } from "../api-client.ts";
import { agents$ } from "../agent.ts";
import { reloadAgentConnectorAuthorizations$ } from "../zero-page/agent-connector-authorizations.ts";

/**
 * Connector type extracted from `/connectors/:type/authorize` route params.
 */
export const directedAuthorizeType$ = computed((get): string | null => {
  const params = get(pathParams$);
  const type = params?.type;
  return typeof type === "string" ? type.toLowerCase() : null;
});

/**
 * Agent ID extracted from `?agentId=` query parameter.
 */
export const directedAuthorizeAgentId$ = computed((get): string | null => {
  return get(searchParams$).get("agentId");
});

/** Agent display name resolved from agentId query param. */
export const directedAuthorizeAgentName$ = computed(async (get) => {
  const agentId = get(directedAuthorizeAgentId$);
  if (!agentId) {
    return null;
  }
  const agents = await get(agents$);
  const agent = agents.find((a) => {
    return a.id === agentId;
  });
  return agent?.displayName ?? null;
});

/** Fetch enabled connector types for the agent from the API. */
export const agentEnabledTypes$ = computed(async (get) => {
  const agentId = get(directedAuthorizeAgentId$);
  if (!agentId) {
    return [];
  }
  const createClient = get(zeroClient$);
  const client = createClient(zeroUserConnectorsContract);
  const result = await accept(client.get({ params: { id: agentId } }), [200]);
  return result.body.enabledTypes;
});

const internalAuthorized$ = state<Set<string>>(new Set());

/** Whether the connector has just been authorized (optimistic). */
export const justAuthorizedTypes$ = computed((get) => {
  return get(internalAuthorized$);
});

/** Authorize a connector for the given agent via user-connectors API. */
export const authorizeConnector$ = command(
  async (
    { get, set },
    connectorType: ConnectorType,
    agentId: string,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroUserConnectorsContract);

    // Get current enabled types for this agent
    const current = await accept(
      client.get({
        params: { id: agentId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    const currentTypes = current.body.enabledTypes;

    // Add the new type if not already present
    if (!currentTypes.includes(connectorType)) {
      await accept(
        client.update({
          params: { id: agentId },
          body: { enabledTypes: [...currentTypes, connectorType] },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
    }

    // Optimistic update
    set(internalAuthorized$, (prev) => {
      return new Set([...prev, connectorType]);
    });
    set(reloadAgentConnectorAuthorizations$);
  },
);
