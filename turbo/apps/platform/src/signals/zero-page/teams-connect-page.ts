import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { ZeroTeamsConnectPage } from "../../views/zero-page/zero-teams-connect-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { initTeamsConnectPage$ } from "./teams-connect-signals.ts";

export const setupTeamsConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = get(featureSwitch$);
    if (!features[FeatureSwitchKey.TeamsIntegration]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(updatePage$, createElement(ZeroTeamsConnectPage));
    set(updateDocumentTitle$, "Connect Microsoft Teams");

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(initTeamsConnectPage$, signal),
    ]);
  },
);
