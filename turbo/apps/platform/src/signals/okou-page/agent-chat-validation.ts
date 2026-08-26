import { command } from "ccstate";
import { currentAgentId$, reloadAgents$ } from "../agent.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

export const retryAgentChatValidation$ = command(({ get, set }) => {
  const agentId = get(currentAgentId$);
  if (!agentId) {
    throw new Error("Chat page requires an active agent, but none found");
  }

  const searchParams = get(searchParams$);
  set(reloadAgents$);
  set(detachedNavigateTo$, ROUTES.agentChat, {
    pathParams: { agentId },
    searchParams,
    replace: true,
  });
});
