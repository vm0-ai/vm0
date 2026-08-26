import { command, computed, state } from "ccstate";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  customConnectorSlugSchema,
  type CustomConnectorSlug,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { pathParams$, searchParams$ } from "../route.ts";
import { agents$ } from "../agent.ts";

/**
 * Connector slug extracted from `/connectors/:connectorSlug/connect` route params.
 */
export const directedConnectSlug$ = computed((get): ConnectorSlug | null => {
  const params = get(pathParams$);
  const connectorSlug = params?.connectorSlug;
  const parsed = connectorSlugSchema.safeParse(
    typeof connectorSlug === "string" ? connectorSlug.toLowerCase() : null,
  );
  return parsed.success ? parsed.data : null;
});

export const directedConnectCustomSlug$ = computed(
  (get): CustomConnectorSlug | null => {
    const params = get(pathParams$);
    const connectorSlug = params?.connectorSlug;
    const parsed = customConnectorSlugSchema.safeParse(
      typeof connectorSlug === "string" ? connectorSlug.toLowerCase() : null,
    );
    return parsed.success ? parsed.data : null;
  },
);

/**
 * Agent ID extracted from `?agentId=` query parameter on the connect page.
 * When present, the connect page will auto-authorize the agent after connecting.
 */
export const directedConnectAgentId$ = computed((get): string | null => {
  return get(searchParams$).get("agentId");
});

/** Agent display name resolved from agentId query param on connect page. */
export const directedConnectAgentName$ = computed(async (get) => {
  const agentId = get(directedConnectAgentId$);
  if (!agentId) {
    return { agentId: null, displayName: null };
  }
  const agents = await get(agents$);
  const agent = agents.find((a) => {
    return a.agentId === agentId;
  });
  return { agentId, displayName: agent?.displayName ?? null };
});

type DirectedConnectManualGrantDialogKey = {
  readonly connectorSlug: ConnectorSlug;
  readonly agentId: string | null;
  readonly signal: AbortSignal;
};

type DirectedConnectModalKey = {
  readonly connectorSlug: ConnectorSlug;
  readonly agentId: string | null;
  readonly signal: AbortSignal;
};

type DirectedConnectCustomDialogKey = {
  readonly connectorSlug: CustomConnectorSlug;
  readonly agentId: string | null;
  readonly signal: AbortSignal;
};

const internalManualGrantDialogKey$ =
  state<DirectedConnectManualGrantDialogKey | null>(null);
const internalDirectedConnectModalKey$ = state<DirectedConnectModalKey | null>(
  null,
);
const internalDirectedConnectCustomDialogKey$ =
  state<DirectedConnectCustomDialogKey | null>(null);
export const manualGrantDialogKey$ = computed((get) => {
  return get(internalManualGrantDialogKey$);
});
export const directedConnectModalKey$ = computed((get) => {
  return get(internalDirectedConnectModalKey$);
});
export const directedConnectCustomDialogKey$ = computed((get) => {
  return get(internalDirectedConnectCustomDialogKey$);
});
export const setManualGrantDialogKey$ = command(
  ({ set }, key: DirectedConnectManualGrantDialogKey | null) => {
    set(internalManualGrantDialogKey$, key);
  },
);
export const setDirectedConnectModalKey$ = command(
  ({ set }, key: DirectedConnectModalKey | null) => {
    set(internalDirectedConnectModalKey$, key);
  },
);
export const setDirectedConnectCustomDialogKey$ = command(
  ({ set }, key: DirectedConnectCustomDialogKey | null) => {
    set(internalDirectedConnectCustomDialogKey$, key);
  },
);
