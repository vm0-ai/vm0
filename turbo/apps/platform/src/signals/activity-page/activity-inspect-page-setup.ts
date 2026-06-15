import { command } from "ccstate";
import { createElement } from "react";
import { ActivityInspectPage } from "../../views/activity-page/activity-inspect-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupActivityInspectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(updatePage$, createElement(ActivityInspectPage), "sidebar");
    set(updateDocumentTitle$, "Inspect Log");
    await set(hideAppSkeleton$, signal);
  },
);
