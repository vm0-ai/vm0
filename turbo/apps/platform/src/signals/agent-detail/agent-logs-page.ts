import { command } from "ccstate";
import { createElement } from "react";
import { AgentLogsPage } from "../../views/agent-detail-page/agent-logs-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentDetail$ } from "./agent-detail.ts";

export const setupAgentLogsPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(AgentLogsPage));
  await set(fetchAgentDetail$);
});
