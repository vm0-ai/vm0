import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router";
import { navigate$ } from "../route.ts";
import { GitHubSettingsPage } from "../../views/integrations-page/github-settings-page";
import {
  fetchGitHubIntegration$,
  githubIntegrationNotLinked$,
} from "./github-integration.ts";
import { fetchAgentsList$ } from "../agents-page/agents-list.ts";

/**
 * Setup the GitHub settings detail page.
 * Redirects to integrations tab if not linked.
 */
export const setupGitHubSettingsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(GitHubSettingsPage));
    await Promise.all([set(fetchGitHubIntegration$), set(fetchAgentsList$)]);
    signal.throwIfAborted();

    if (get(githubIntegrationNotLinked$)) {
      await set(
        navigate$,
        "/settings",
        { searchParams: new URLSearchParams({ tab: "integrations" }) },
        signal,
      );
    }
  },
);
