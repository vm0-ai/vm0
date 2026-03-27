import { command } from "ccstate";
import { navigateTo$, searchParams$ } from "../route.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { logger } from "../log.ts";
import { defaultAgentId$ } from "./zero-agent-name.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$ } from "./zero-page.ts";

const L = logger("ChatPage");

export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(loadInitialData$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(checkSettingsParam$, signal);

    // Redirect bare / to /talk/:defaultAgent, forwarding ?prompt= if present
    const rawName = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (rawName) {
      L.info("redirecting to /talk/", rawName);
      const params = get(searchParams$);
      const prompt = params.get("prompt");
      set(navigateTo$, "/talk/:id", {
        pathParams: { id: rawName },
        searchParams: prompt ? new URLSearchParams({ prompt }) : undefined,
        replace: true,
      });
    }
  },
);
