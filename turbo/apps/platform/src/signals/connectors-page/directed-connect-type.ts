import { command, computed, state } from "ccstate";
import { pathParams$, searchParams$ } from "../route.ts";
import { agents$ } from "../agent.ts";

/**
 * Connector type extracted from `/connectors/:type/connect` route params.
 */
export const directedConnectType$ = computed((get): string | null => {
  const params = get(pathParams$);
  const type = params?.type;
  return typeof type === "string" ? type.toLowerCase() : null;
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
    return null;
  }
  const agents = await get(agents$);
  const agent = agents.find((a) => {
    return a.id === agentId;
  });
  return agent?.displayName ?? null;
});

const internalTokenDialogOpen$ = state(false);
export const tokenDialogOpen$ = computed((get) => {
  return get(internalTokenDialogOpen$);
});
export const setTokenDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalTokenDialogOpen$, open);
});
