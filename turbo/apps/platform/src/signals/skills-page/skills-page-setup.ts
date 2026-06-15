import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { SkillsPage } from "../../views/skills-page/skills-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupSkillsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = await get(featureSwitch$);
    signal.throwIfAborted();

    if (!features[FeatureSwitchKey.SkillsViewer]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    set(updatePage$, createElement(SkillsPage), "sidebar");
    set(updateDocumentTitle$, "Skills");
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
