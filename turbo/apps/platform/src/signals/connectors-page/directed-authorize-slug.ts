import { command, computed, state } from "ccstate";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { zeroClient$ } from "../api-client.ts";
import { agents$ } from "../agent.ts";
import { withCleanup } from "../utils.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "../zero-page/agent-connector-authorizations.ts";

/**
 * Connector slug extracted from `/connectors/:connectorSlug/authorize` route params.
 */
export const directedAuthorizeSlug$ = computed((get): ConnectorSlug | null => {
  const params = get(pathParams$);
  const connectorSlug = params?.connectorSlug;
  const parsed = connectorSlugSchema.safeParse(
    typeof connectorSlug === "string" ? connectorSlug.toLowerCase() : null,
  );
  return parsed.success ? parsed.data : null;
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
    return { agentId: null, displayName: null };
  }
  const agents = await get(agents$);
  const agent = agents.find((a) => {
    return a.id === agentId;
  });
  return { agentId, displayName: agent?.displayName ?? null };
});

/** Fetch enabled connector slugs for the agent from the API. */
export const agentEnabledConnectorSlugs$ = computed(async (get) => {
  const agentId = get(directedAuthorizeAgentId$);
  if (!agentId) {
    return { agentId: null, enabledConnectorSlugs: [] };
  }
  const authorizations = await get(
    agentConnectorAuthorizations({ agentId, missing: "null" }),
  );
  return {
    agentId,
    enabledConnectorSlugs: [...(authorizations?.enabledConnectorSlugs ?? [])],
  };
});

export type DirectedAuthorizeConnectModalKey = {
  readonly connectorSlug: ConnectorSlug;
  readonly agentId: string;
  readonly signal: AbortSignal;
};

const internalDirectedAuthorizeConnectModalKey$ =
  state<DirectedAuthorizeConnectModalKey | null>(null);
export const directedAuthorizeConnectModalKey$ = computed((get) => {
  return get(internalDirectedAuthorizeConnectModalKey$);
});
export const setDirectedAuthorizeConnectModalKey$ = command(
  ({ set }, key: DirectedAuthorizeConnectModalKey | null) => {
    set(internalDirectedAuthorizeConnectModalKey$, key);
  },
);

function connectorAgentAuthorizationKey(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly agentId: string;
}): string {
  return `${args.agentId}:${args.connectorSlug}`;
}

const internalAuthorized$ = state<Set<string>>(new Set());

/** Whether the connector has just been authorized (optimistic). */
export const justAuthorizedConnectorAgentKeys$ = computed((get) => {
  return get(internalAuthorized$);
});

/** Authorize a connector for the given agent via user-connectors API. */
export const authorizeConnector$ = command(
  async (
    { get, set },
    connectorSlug: ConnectorSlug,
    agentId: string,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroUserConnectorsContract);

    await withCleanup(
      accept(
        client.update({
          params: { id: agentId },
          body: {
            enabledConnectorSlugs: [connectorSlug],
            operation: "add",
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

    // Optimistic update
    set(internalAuthorized$, (prev) => {
      return new Set([
        ...prev,
        connectorAgentAuthorizationKey({ connectorSlug, agentId }),
      ]);
    });
  },
);

export function isJustAuthorizedConnectorAgent(
  justAuthorizedKeys: ReadonlySet<string>,
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly agentId: string;
  },
): boolean {
  return justAuthorizedKeys.has(connectorAgentAuthorizationKey(args));
}
