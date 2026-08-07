import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityPage } from "../../views/zero-page/zero-activity-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroActivity$, refreshZeroActivity$ } from "./activity-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { i18n } from "../../i18n/index.ts";

export const setupActivityPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.activity.documentTitle;
      }),
    );
    set(refreshZeroActivity$);
    await set(initZeroActivity$, signal);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
