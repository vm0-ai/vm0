import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { PreferencesPage } from "../../views/okou-page/preferences-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupPreferencesPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(PreferencesPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.settings.preferences.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
