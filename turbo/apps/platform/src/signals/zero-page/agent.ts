import { computed } from "ccstate";
import { pathParams$ } from "../route";

export const currentAgentId$ = computed((get) => {
  const params = get(pathParams$);
  const agentId = params?.agentId;
  return typeof agentId === "string" ? agentId : null;
});
