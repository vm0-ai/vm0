import { command } from "ccstate";
import { createElement } from "react";

import { BrowserAuthorizationPage } from "../../views/browser-authorization/browser-authorization-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupBrowserAuthorizationPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(BrowserAuthorizationPage), "minimal");
    set(updateDocumentTitle$, "Enable cloud browser");
    await set(hideAppSkeleton$, signal);
    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
