import { command } from "ccstate";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { defaultAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(checkSettingsParam$, signal);

    // Redirect bare / to /agents/:id/chat, forwarding ?prompt= if present
    const defaultAgentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (defaultAgentId) {
      const params = get(searchParams$);
      const prompt = params.get("prompt");
      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId: defaultAgentId },
        searchParams: prompt ? new URLSearchParams({ prompt }) : undefined,
        replace: true,
      });
    }
  },
);
