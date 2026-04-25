import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/api-contracts/feature-switch-key";
import { ApiKeysPage } from "../../views/zero-page/api-keys-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

export const setupApiKeysPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = await get(featureSwitch$);
    signal.throwIfAborted();
    if (!features[FeatureSwitchKey.ApiKeys]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    set(updatePage$, createElement(ApiKeysPage), "sidebar");
    set(updateDocumentTitle$, "API Keys");
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
