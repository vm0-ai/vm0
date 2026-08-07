import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { command } from "ccstate";
import { createElement } from "react";

import { ZeroStrapiSettingsPage } from "../../views/zero-page/strapi-settings-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { resetStrapiSettings$ } from "./zero-strapi.ts";
import { i18n } from "../../i18n/index.ts";

export const setupStrapiSettingsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.StrapiIntegration]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }
    if (await set(onboardGuard$, signal)) {
      return;
    }
    set(resetStrapiSettings$);
    set(updatePage$, createElement(ZeroStrapiSettingsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerSettings.strapi.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
