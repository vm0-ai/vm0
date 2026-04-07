import { command, computed, state } from "ccstate";
import { zeroUserConnectorsContract, type ConnectorType } from "@vm0/core";
import { pathParams$, searchParams$ } from "../route.ts";
import { zeroClient$ } from "../api-client.ts";

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

/** Fetch enabled connector types for the agent from the API. */
export const agentEnabledTypes$ = computed(async (get) => {
  const agentId = get(directedAuthorizeAgentId$);
  if (!agentId) {
    return [];
  }
  const createClient = get(zeroClient$);
  const client = createClient(zeroUserConnectorsContract);
  const result = await client.get({ params: { id: agentId } });
  if (result.status !== 200) {
    return [];
  }
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
    const current = await client.get({ params: { id: agentId } });
    signal.throwIfAborted();

    const currentTypes =
      current.status === 200 ? current.body.enabledTypes : [];

    // Add the new type if not already present
    if (!currentTypes.includes(connectorType)) {
      const result = await client.update({
        params: { id: agentId },
        body: { enabledTypes: [...currentTypes, connectorType] },
      });
      signal.throwIfAborted();

      if (result.status !== 200) {
        const detail =
          result.status === 400 || result.status === 404
            ? result.body.error.message
            : `status ${result.status}`;
        throw new Error(`Authorization failed: ${detail}`);
      }
    }

    // Optimistic update
    set(internalAuthorized$, (prev) => {
      return new Set([...prev, connectorType]);
    });
  },
);
