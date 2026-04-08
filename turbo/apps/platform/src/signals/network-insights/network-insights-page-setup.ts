import { command } from "ccstate";
import { createElement } from "react";
import { delay } from "signal-timers";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { NetworkInsightsPage } from "../../views/network-insights/network-insights-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../agent-chat.ts";
import { reloadInsights$ } from "./network-insights-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { tickInsightsRelativeTime$ } from "./network-insights-signals.ts";

export const setupNetworkInsightsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(NetworkInsightsPage)),
    );
    set(updateDocumentTitle$, "Insights");
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
    set(reloadInsights$);

    // Tick relative timestamps every 60 s until page is unmounted.
    while (!signal.aborted) {
      await delay(60_000, { signal });
      set(tickInsightsRelativeTime$);
    }
  },
);
