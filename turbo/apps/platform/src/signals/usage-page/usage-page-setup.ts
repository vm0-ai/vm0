import { command } from "ccstate";
import { createElement } from "react";
import { ZeroUsagePage } from "../../views/zero-page/zero-usage-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { setRange$ } from "./usage-insight-signals.ts";
import { i18n } from "../../i18n/index.ts";

export const setupUsagePage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroUsagePage), "sidebar");
  set(
    updateDocumentTitle$,
    i18n.t(($) => {
      return $.usage.page.title;
    }),
  );
  set(setRange$, "today");
  await set(hideAppSkeleton$, signal);

  if (await set(onboardGuard$, signal)) {
    return;
  }
});
