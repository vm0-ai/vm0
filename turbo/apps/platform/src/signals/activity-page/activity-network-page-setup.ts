import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroActivityNetworkPage } from "../../views/zero-page/zero-activity-network-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";

export const setupActivityNetworkPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(
        SidebarLayout,
        null,
        createElement(ZeroActivityNetworkPage),
      ),
    );
    set(updateDocumentTitle$, "Network Logs");

    await set(initZeroOnboarding$, signal);
    if (await set(onboardGuard$, signal)) {
      return;
    }

    signal.throwIfAborted();
  },
);
