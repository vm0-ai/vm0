import { command } from "ccstate";
import { createElement } from "react";
import { AgentsPage } from "../../views/agents-page/agents-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "./agents-list.ts";

export const setupAgentsPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(AgentsPage));
  await set(fetchAgentsList$);
});
