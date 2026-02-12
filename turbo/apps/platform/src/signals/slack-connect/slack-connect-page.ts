import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { navigate$ } from "../route.ts";
import { hasAnyModelProvider$ } from "../external/model-providers.ts";
import { throwIfAbort } from "../utils.ts";
import { initSlackConnect$, slackConnectParams$ } from "./slack-connect.ts";
import { SlackConnectPage } from "../../views/slack-connect/slack-connect-page.tsx";

export const setupSlackConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Render page first so the user sees the loading spinner
    set(updatePage$, createElement(SlackConnectPage));

    // Check provider — redirect to setup if none configured
    let hasProvider = false;
    try {
      hasProvider = await get(hasAnyModelProvider$);
    } catch (error) {
      throwIfAbort(error);
    }
    signal.throwIfAborted();

    if (!hasProvider) {
      const { slackUserId, workspaceId, channelId } = get(slackConnectParams$);
      const connectParams = new URLSearchParams();
      if (workspaceId) {
        connectParams.set("w", workspaceId);
      }
      if (slackUserId) {
        connectParams.set("u", slackUserId);
      }
      if (channelId) {
        connectParams.set("c", channelId);
      }
      const connectQs = connectParams.toString();
      const returnPath = `/slack/connect${connectQs ? `?${connectQs}` : ""}`;

      const setupParams = new URLSearchParams();
      setupParams.set("return", returnPath);
      await set(
        navigate$,
        "/provider-setup",
        { searchParams: setupParams },
        signal,
      );
      signal.throwIfAborted();
      return;
    }

    await set(initSlackConnect$);
  },
);
