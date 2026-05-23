import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { checkSettingsParam$ } from "./settings/org-manage-dialog.ts";
import { checkUnifiedSettingsParam$ } from "./settings/settings-dialog.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { homeAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    const features = get(featureSwitch$);
    if (features[FeatureSwitchKey.UnifiedSettings]) {
      await set(checkUnifiedSettingsParam$, signal);
    } else {
      await set(checkSettingsParam$, signal);
    }

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
