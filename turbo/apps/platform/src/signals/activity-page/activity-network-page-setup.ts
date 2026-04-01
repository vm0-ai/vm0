import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityNetworkPageWrapper } from "../../views/activity-page/zero-activity-network-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";

export const setupActivityNetworkPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityNetworkPageWrapper));
    set(updateDocumentTitle$, "Network Logs");

    await set(initZeroOnboarding$, signal);
    if (await set(onboardGuard$, signal)) {
      return;
    }

    signal.throwIfAborted();
  },
);
