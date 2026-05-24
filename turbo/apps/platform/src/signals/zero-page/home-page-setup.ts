import { command } from "ccstate";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { checkUnifiedSettingsParam$ } from "./settings/settings-dialog.ts";
import { homeAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(checkUnifiedSettingsParam$, signal);

    // Redirect bare / to /agents/:id/chat. Use-case "Try It" deep links go
    // through /onboarding directly (see buildPromptHref in use-cases/data.ts),
    // so we no longer intercept ?prompt= here. ?queue= is forwarded so the
    // queue drawer opens on arrival.
    const homeAgentId = await get(homeAgentId$);
    signal.throwIfAborted();
    if (!homeAgentId) {
      return;
    }
    const params = get(searchParams$);
    const queue = params.get("queue");
    const forwardParams = new URLSearchParams();
    if (queue) {
      forwardParams.set("queue", queue);
    }
    set(detachedNavigateTo$, "/agents/:agentId/chat", {
      pathParams: { agentId: homeAgentId },
      searchParams: forwardParams.size > 0 ? forwardParams : undefined,
      replace: true,
    });
  },
);
