import { computed } from "ccstate";
import { pathParams$ } from "../route";
import { activeRoute$ } from "../active-route.ts";

export const currentAgentId$ = computed((get) => {
  const route = get(activeRoute$);
  if (
    route !== "agentDetail" &&
    route !== "agentChat" &&
    route !== "agentIdeas" &&
    route !== "agentPermissions"
  ) {
    return null;
  }
  const params = get(pathParams$);
  const id = params?.id;
  return typeof id === "string" ? id : null;
});
