import { command } from "ccstate";
import { navigateTo$ } from "../route.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { logger } from "../log.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import { loadInitialData$ } from "./zero-page.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "./zero-onboarding.ts";

const L = logger("ChatPage");

export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(loadInitialData$, signal);

    // Consume ?settings=<tab> param before redirecting
    set(checkSettingsParam$);

    // Redirect to /onboarding when needed
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const needsMemberOnboarding = await get(zeroNeedsMemberOnboarding$);
    signal.throwIfAborted();
    if (needsOnboarding || needsMemberOnboarding) {
      L.info("redirecting to /onboarding");
      set(navigateTo$, "/onboarding", { replace: true });
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
