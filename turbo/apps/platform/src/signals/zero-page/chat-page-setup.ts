import { command } from "ccstate";
import { createElement } from "react";
import { ZeroAppShell } from "../../views/zero-page/zero-app-shell.tsx";
import { updatePage$ } from "../react-router.ts";
import { pathname$ } from "../route.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { logger } from "../log.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import { switchActiveAgent$ } from "./zero-chat.ts";
import { loadInitialData$ } from "./zero-page.ts";

const L = logger("ChatPage");

export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroAppShell));

    await set(loadInitialData$, signal);

    // Consume ?settings=<tab> param before redirecting
    set(checkSettingsParam$);

    // Redirect bare / to /talk/:defaultAgent
    const currentPath = get(pathname$);
    L.info("chat root path:", currentPath);

    if (/^\/?$/.test(currentPath)) {
      const rawName = await get(defaultAgentName$);
      signal.throwIfAborted();
      if (rawName) {
        window.history.replaceState(
          {},
          "",
          `/talk/${encodeURIComponent(rawName)}`,
        );
      }
    }

    // Switch to default agent
    set(switchActiveAgent$, null);
    set(syncModelPreference$);
  },
);
