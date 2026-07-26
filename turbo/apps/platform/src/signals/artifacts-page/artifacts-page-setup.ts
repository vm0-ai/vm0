import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { ArtifactCatalogPage } from "../../views/artifacts-page/artifact-catalog-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import {
  reloadArtifactCatalog$,
  setArtifactCatalogKind$,
} from "./artifact-catalog-signals.ts";

export const setupArtifactsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = await get(featureSwitch$);
    signal.throwIfAborted();

    if (!features[FeatureSwitchKey.Artifacts]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    // Entering the page always starts a fresh first page. Later pages are
    // fetched on scroll and never cached across visits.
    set(setArtifactCatalogKind$, null);
    set(reloadArtifactCatalog$);
    set(updatePage$, createElement(ArtifactCatalogPage), "sidebar");
    set(updateDocumentTitle$, "Artifacts");
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
