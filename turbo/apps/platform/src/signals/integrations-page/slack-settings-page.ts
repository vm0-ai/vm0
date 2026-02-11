import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router";
import { SlackSettingsPage } from "../../views/integrations-page/slack-settings-page";
import { fetchSlackIntegration$ } from "./slack-integration.ts";
import { fetchAgentsList$ } from "../agents-page/agents-list.ts";

/**
 * Setup the Slack settings detail page.
 */
export const setupSlackSettingsPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(SlackSettingsPage));
  await Promise.all([set(fetchSlackIntegration$), set(fetchAgentsList$)]);
});
