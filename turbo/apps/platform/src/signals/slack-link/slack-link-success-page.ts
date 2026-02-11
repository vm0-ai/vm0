import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { SlackLinkSuccessPage } from "../../views/slack-link/slack-link-success-page.tsx";

export const setupSlackLinkSuccessPage$ = command(({ get, set }) => {
  set(updatePage$, createElement(SlackLinkSuccessPage));

  // Auto-open Slack on page load
  const params = get(searchParams$);
  const workspaceId = params.get("w");
  const channelId = params.get("c");
  const slackDeepLink =
    workspaceId && channelId
      ? `slack://channel?team=${workspaceId}&id=${channelId}`
      : "slack://open";
  window.location.href = slackDeepLink;
});
