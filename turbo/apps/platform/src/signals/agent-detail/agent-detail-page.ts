import { command } from "ccstate";
import { createElement } from "react";
import { AgentDetailPage } from "../../views/agent-detail-page/agent-detail-page.tsx";
import { updatePage$ } from "../react-router.ts";
import {
  fetchAgentDetail$,
  fetchAgentInstructions$,
  initInstructionsViewMode$,
} from "./agent-detail.ts";

export const setupAgentDetailPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(AgentDetailPage));
  set(initInstructionsViewMode$);
  await set(fetchAgentDetail$);
  await set(fetchAgentInstructions$);
});
