import { command } from "ccstate";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { defaultAgentId$ } from "./zero-agent-name.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$ } from "./zero-page.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(loadInitialData$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(checkSettingsParam$, signal);

    // Redirect bare / to /talk/:defaultAgent, forwarding ?prompt= if present
    const defaultAgentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (defaultAgentId) {
      const params = get(searchParams$);
      const prompt = params.get("prompt");
      set(detachedNavigateTo$, "/talk/:agentId", {
        pathParams: { agentId: defaultAgentId },
        searchParams: prompt ? new URLSearchParams({ prompt }) : undefined,
        replace: true,
      });
    }
  },
);
