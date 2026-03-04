import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router";
import { GitHubSettingsPage } from "../../views/integrations-page/github-settings-page";
import { fetchGitHubIntegration$ } from "./github-integration.ts";
import { fetchAgentsList$ } from "../agents-page/agents-list.ts";

/**
 * Setup the GitHub settings detail page.
 */
export const setupGitHubSettingsPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(GitHubSettingsPage));
  await Promise.all([set(fetchGitHubIntegration$), set(fetchAgentsList$)]);
});
