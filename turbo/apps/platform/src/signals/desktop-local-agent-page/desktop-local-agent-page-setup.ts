import { createElement } from "react";
import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { ZeroDesktopLocalAgentPage } from "../../views/zero-page/desktop-local-agent-page.tsx";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updatePage$ } from "../react-router.ts";
import { setupDesktopLocalAgentBridge$ } from "./desktop-local-agent-signals.ts";

export const setupDesktopLocalAgentPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const enabled = get(featureSwitch$)[FeatureSwitchKey.DesktopLocalAgent];
    const api = window.vm0DesktopLocalAgent;
    if (!enabled || !api) {
      await api?.setEnabled(false);
      signal.throwIfAborted();
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    set(updatePage$, createElement(ZeroDesktopLocalAgentPage), "sidebar");
    await set(setupDesktopLocalAgentBridge$, signal);
  },
);
