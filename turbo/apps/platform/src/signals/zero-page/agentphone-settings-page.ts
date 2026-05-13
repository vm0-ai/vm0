import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import {
  reloadAgentPhoneLinkStatus$,
  resetAgentPhoneSettingsUi$,
} from "./zero-agentphone.ts";
import { ZeroAgentPhoneSettingsPage } from "../../views/zero-page/zero-agentphone-settings-page.tsx";

export const setupAgentPhoneSettingsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = await get(featureSwitch$);
    signal.throwIfAborted();
    if (!features[FeatureSwitchKey.AgentPhoneAppUi]) {
      set(detachedNavigateTo$, ROUTES.works, { replace: true });
      return;
    }

    set(resetAgentPhoneSettingsUi$);
    set(reloadAgentPhoneLinkStatus$);
    set(updatePage$, createElement(ZeroAgentPhoneSettingsPage), "sidebar");
    set(updateDocumentTitle$, "AgentPhone");

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(onboardGuard$, signal),
    ]);
  },
);
