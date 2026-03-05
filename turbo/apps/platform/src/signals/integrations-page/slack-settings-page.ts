import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router";
import { navigate$ } from "../route.ts";
import { SlackSettingsPage } from "../../views/integrations-page/slack-settings-page";
import {
  fetchSlackIntegration$,
  slackIntegrationNotLinked$,
} from "./slack-integration.ts";
import { fetchAgentsList$ } from "../agents-page/agents-list.ts";

/**
 * Setup the Slack settings detail page.
 * Redirects to integrations tab if not linked.
 */
export const setupSlackSettingsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(SlackSettingsPage));
    await Promise.all([set(fetchSlackIntegration$), set(fetchAgentsList$)]);
    signal.throwIfAborted();

    if (get(slackIntegrationNotLinked$)) {
      await set(
        navigate$,
        "/settings",
        { searchParams: new URLSearchParams({ tab: "integrations" }) },
        signal,
      );
    }
  },
);
