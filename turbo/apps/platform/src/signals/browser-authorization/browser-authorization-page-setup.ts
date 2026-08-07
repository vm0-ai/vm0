import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { BrowserAuthorizationPage } from "../../views/browser-authorization/browser-authorization-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupBrowserAuthorizationPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(BrowserAuthorizationPage), "minimal");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.authorization.browser.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
