import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { EnvironmentVariablesSetupPage } from "../../views/environment-variables-setup/environment-variables-setup-page.tsx";
import { initEnvironmentVariablesSetup$ } from "./environment-variables-setup.ts";

export const setupEnvironmentVariablesSetupPage$ = command(({ set }) => {
  set(initEnvironmentVariablesSetup$);
  set(updatePage$, createElement(EnvironmentVariablesSetupPage));
});
