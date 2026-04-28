import { command } from "ccstate";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { homeAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

// Matches Tailwind's md breakpoint (768px). Below this width we treat the
// viewport as mobile and land users on the chats list instead of the
// default agent's chat thread, since that's the canonical mobile entry point.
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

function isMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(MOBILE_MEDIA_QUERY).matches
  );
}

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(checkSettingsParam$, signal);

    // On mobile, the home entry point is the chats list — skip the
    // default-agent redirect so users land on /chats instead.
    if (isMobileViewport()) {
      set(detachedNavigateTo$, "/chats", { replace: true });
      return;
    }

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
