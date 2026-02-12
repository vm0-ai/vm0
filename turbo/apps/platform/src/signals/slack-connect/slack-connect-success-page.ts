import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { SlackConnectSuccessPage } from "../../views/slack-connect/slack-connect-success-page.tsx";

export const setupSlackConnectSuccessPage$ = command(({ get, set }) => {
  set(updatePage$, createElement(SlackConnectSuccessPage));

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
