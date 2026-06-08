import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { MemoryPage } from "../../views/memory-page/memory-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupMemoryPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = await get(featureSwitch$);
    signal.throwIfAborted();

    if (!features[FeatureSwitchKey.MemoryViewer]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    set(updatePage$, createElement(MemoryPage), "sidebar");
    set(updateDocumentTitle$, "Memory");
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
