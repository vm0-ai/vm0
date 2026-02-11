import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { ProviderSetupPage } from "../../views/provider-setup/provider-setup-page.tsx";

export const setupProviderSetupPage$ = command(({ set }) => {
  set(updatePage$, createElement(ProviderSetupPage));
});
