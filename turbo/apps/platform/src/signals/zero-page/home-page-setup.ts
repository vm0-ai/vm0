import { command } from "ccstate";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { homeAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(checkSettingsParam$, signal);

    // Redirect bare / to /agents/:id/chat, forwarding ?prompt= and ?queue= if present
    const homeAgentId = await get(homeAgentId$);
    signal.throwIfAborted();
    if (homeAgentId) {
      const params = get(searchParams$);
      const forwardParams = new URLSearchParams();
      const prompt = params.get("prompt");
      const queue = params.get("queue");
      if (prompt) {
        forwardParams.set("prompt", prompt);
      }
      if (queue) {
        forwardParams.set("queue", queue);
      }
      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId: homeAgentId },
        searchParams: forwardParams.size > 0 ? forwardParams : undefined,
        replace: true,
      });
    }
  },
);
