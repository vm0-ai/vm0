import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroActivityContextPage } from "../../views/zero-page/zero-activity-context-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";

export const setupActivityContextPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(
        SidebarLayout,
        null,
        createElement(ZeroActivityContextPage),
      ),
    );
    set(updateDocumentTitle$, "Run Context");

    await set(initZeroOnboarding$, signal);
    if (await set(onboardGuard$, signal)) {
      return;
    }

    signal.throwIfAborted();
  },
);
