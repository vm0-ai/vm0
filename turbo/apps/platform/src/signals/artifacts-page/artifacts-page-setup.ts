import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";

import { ArtifactCatalogPage } from "../../views/artifacts-page/artifact-catalog-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import {
  reloadArtifactCatalog$,
  setArtifactCatalogKind$,
} from "./artifact-catalog-signals.ts";

export const setupArtifactsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    // Entering the page always starts a fresh first page. Later pages are
    // fetched on scroll and never cached across visits.
    set(setArtifactCatalogKind$, "presentation");
    set(reloadArtifactCatalog$);
    set(updatePage$, createElement(ArtifactCatalogPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.artifacts.title;
      }),
    );
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
