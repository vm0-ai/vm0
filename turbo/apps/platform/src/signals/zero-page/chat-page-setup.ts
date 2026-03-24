import { command } from "ccstate";
import { navigateTo$ } from "../route.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { logger } from "../log.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$ } from "./zero-page.ts";
import { detach, Reason } from "../utils.ts";

const L = logger("ChatPage");

export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(loadInitialData$, signal);

    // Consume ?settings=<tab> param before redirecting
    detach(set(checkSettingsParam$), Reason.Entrance);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    // Redirect bare / to /talk/:defaultAgent
    const rawName = await get(defaultAgentName$);
    signal.throwIfAborted();
    if (rawName) {
      L.info("redirecting to /talk/", rawName);
      set(navigateTo$, "/talk/:name", {
        pathParams: { name: rawName },
        replace: true,
      });
    }
  },
);
