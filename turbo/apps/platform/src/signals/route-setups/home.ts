import { setupAgentDetailPage$ } from "../agents-page/agent-detail-page-setup.ts";
import { setupAgentsPage$ } from "../agents-page/agents-page-setup.ts";
import { setupHomePage$ } from "../okou-page/home-page-setup.ts";

export function getHomeRouteSetups() {
  return {
    setupAgentDetailPage$,
    setupAgentsPage$,
    setupHomePage$,
  };
}
