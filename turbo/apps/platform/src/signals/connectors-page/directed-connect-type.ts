import { computed } from "ccstate";
import { pathParams$ } from "../route.ts";

/**
 * Connector type extracted from `/connectors/:type/connect` route params.
 */
export const directedConnectType$ = computed((get): string | null => {
  const params = get(pathParams$);
  const type = params?.type;
  return typeof type === "string" ? type : null;
});
