import { command, computed, state } from "ccstate";
import {
  connectorRefSchema,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import { pathParams$, searchParams$ } from "../route.ts";
import { agents$ } from "../agent.ts";

/**
 * Connector type extracted from `/connectors/:type/connect` route params.
 */
export const directedConnectType$ = computed((get): string | null => {
  const params = get(pathParams$);
  const type = params?.type;
  const parsed = connectorRefSchema.safeParse(
    typeof type === "string" ? type.toLowerCase() : null,
  );
  return parsed.success ? parsed.data : null;
});

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
    return a.id === agentId;
  });
  return { agentId, displayName: agent?.displayName ?? null };
});

export type DirectedConnectManualGrantDialogKey = {
  readonly connectorType: ConnectorRef;
  readonly agentId: string | null;
  readonly signal: AbortSignal;
};

export type DirectedConnectModalKey = {
  readonly connectorType: ConnectorRef;
  readonly agentId: string | null;
  readonly signal: AbortSignal;
};

const internalManualGrantDialogKey$ =
  state<DirectedConnectManualGrantDialogKey | null>(null);
const internalDirectedConnectModalKey$ = state<DirectedConnectModalKey | null>(
  null,
);
export const manualGrantDialogKey$ = computed((get) => {
  return get(internalManualGrantDialogKey$);
});
export const directedConnectModalKey$ = computed((get) => {
  return get(internalDirectedConnectModalKey$);
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
