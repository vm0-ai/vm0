import { command, computed, state } from "ccstate";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  customConnectorSlugSchema,
  type CustomConnectorSlug,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { z } from "zod";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { agents$ } from "../agent.ts";
import { pageSignal$ } from "../page-signal.ts";
import { resetManualGrantForm$ } from "../okou-page/settings/connectors.ts";
import { customConnectors$ } from "../okou-page/settings/custom-connectors.ts";
import { customConnectorMcpEnabled$ } from "../external/feature-switch.ts";

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

type DirectedConnectAccountTarget =
  | { readonly kind: "default" }
  | { readonly kind: "invalid" }
  | { readonly kind: "exact"; readonly connectionId: string };

export const directedConnectAccountTarget$ = computed(
  (get): DirectedConnectAccountTarget => {
    const connectionId = get(pathParams$)?.connectionId;
    if (connectionId === undefined) {
      return { kind: "default" };
    }
    const parsed = z.uuid().safeParse(connectionId);
    return parsed.success
      ? { kind: "exact", connectionId: parsed.data }
      : { kind: "invalid" };
  },
);

export const directedConnectExactAccount$ = computed(
  async (get): Promise<ConnectorAccountConnection | null> => {
    const target = get(directedConnectAccountTarget$);
    const connectorSlug = get(directedConnectSlug$);
    const customSlug = get(directedConnectCustomSlug$);
    if (target.kind !== "exact" || (!connectorSlug && !customSlug)) {
      return null;
    }
    const signal = get(pageSignal$);
    const mcpEnabled = get(customConnectorMcpEnabled$);
    const customConnector = customSlug
      ? (await get(customConnectors$)).find((connector) => {
          return (
            connector.slug === customSlug &&
            (connector.kind === "http" || mcpEnabled)
          );
        })
      : undefined;
    signal.throwIfAborted();
    const query = connectorSlug
      ? { kind: "builtin" as const, connectorSlug }
      : customConnector
        ? { kind: "custom" as const, customConnectorId: customConnector.id }
        : null;
    if (!query) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).connection({
        params: { connectionId: target.connectionId },
        query,
        fetchOptions: { signal },
      }),
      [200, 404],
    );
    signal.throwIfAborted();
    return result.status === 200 ? result.body : null;
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
    if (key) {
      set(resetManualGrantForm$, key.connectorSlug);
    }
    set(internalManualGrantDialogKey$, key);
  },
);
export const setDirectedConnectModalKey$ = command(
  ({ set }, key: DirectedConnectModalKey | null) => {
    if (key) {
      set(resetManualGrantForm$, key.connectorSlug);
    }
    set(internalDirectedConnectModalKey$, key);
  },
);
export const setDirectedConnectCustomDialogKey$ = command(
  ({ set }, key: DirectedConnectCustomDialogKey | null) => {
    set(internalDirectedConnectCustomDialogKey$, key);
  },
);
