import { command } from "ccstate";
import { createElement } from "react";
import { IntegrationsPage } from "../../views/integrations-page/integrations-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchSlackIntegration$ } from "./slack-integration.ts";

export const setupIntegrationsPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(IntegrationsPage));
  await set(fetchSlackIntegration$);
});
