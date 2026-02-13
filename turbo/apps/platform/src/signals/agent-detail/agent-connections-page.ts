import { command } from "ccstate";
import { createElement } from "react";
import { AgentConnectionsPage } from "../../views/agent-detail-page/agent-connections-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentDetail$ } from "./agent-detail.ts";

export const setupAgentConnectionsPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(AgentConnectionsPage));
  await set(fetchAgentDetail$);
});
