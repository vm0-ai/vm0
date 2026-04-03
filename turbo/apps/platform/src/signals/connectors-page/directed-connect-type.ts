import { command, computed, state } from "ccstate";
import { pathParams$ } from "../route.ts";

/**
 * Connector type extracted from `/connectors/:type/connect` route params.
 */
export const directedConnectType$ = computed((get): string | null => {
  const params = get(pathParams$);
  const type = params?.type;
  return typeof type === "string" ? type.toLowerCase() : null;
});

const internalTokenDialogOpen$ = state(false);
export const tokenDialogOpen$ = computed((get) => {
  return get(internalTokenDialogOpen$);
});
export const setTokenDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalTokenDialogOpen$, open);
});
