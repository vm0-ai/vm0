import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityDetailPage } from "../../views/zero-page/zero-activity-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { setupActivityLogLoop$ } from "./activity-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { i18n } from "../../i18n/index.ts";

export const setupActivityDetailPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityDetailPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.activity.documentTitle;
      }),
    );

    await set(hideAppSkeleton$, signal);
    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(setupActivityLogLoop$, signal);
    signal.throwIfAborted();
  },
);
