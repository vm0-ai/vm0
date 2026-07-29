import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { LabPage } from "../../views/lab-page/lab-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupLabPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(LabPage), "sidebar");
  set(
    updateDocumentTitle$,
    i18n.t(($) => {
      return $.settings.lab.documentTitle;
    }),
  );
  await set(hideAppSkeleton$, signal);

  if (await set(onboardGuard$, signal)) {
    return;
  }
});
