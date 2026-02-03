import { command } from "ccstate";
import { createElement } from "react";
import { AgentsPage } from "../../views/agents-page/agents-page.tsx";
import { updatePage$ } from "../react-router.ts";

export const setupAgentsPage$ = command(({ set }) => {
  set(updatePage$, createElement(AgentsPage));
});
