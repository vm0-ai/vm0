import { command } from "ccstate";
import { createElement } from "react";
import { ActivityInspectPage } from "../../views/activity-page/activity-inspect-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { i18n } from "../../i18n/index.ts";

export const setupActivityInspectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ActivityInspectPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.activity.inspect.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
