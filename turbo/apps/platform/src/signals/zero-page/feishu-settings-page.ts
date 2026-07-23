import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { ZeroFeishuSettingsPage } from "../../views/zero-page/feishu-card.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updatePage$ } from "../react-router.ts";
import {
  reloadFeishuInstallations$,
  resetFeishuSettingsUi$,
  showFeishuSettingsResult$,
  startFeishuSettingsRealtime$,
} from "./zero-feishu.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupFeishuSettingsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = get(featureSwitch$);
    if (!features[FeatureSwitchKey.FeishuIntegration]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(resetFeishuSettingsUi$);
    set(reloadFeishuInstallations$);
    set(showFeishuSettingsResult$);
    set(updatePage$, createElement(ZeroFeishuSettingsPage), "sidebar");
    set(updateDocumentTitle$, "Feishu");

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(startFeishuSettingsRealtime$, signal),
    ]);
  },
);
