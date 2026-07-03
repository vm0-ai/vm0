import { command } from "ccstate";
import { createElement } from "react";
import { NetworkInsightsPage } from "../../views/network-insights/network-insights-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../agent-chat.ts";
import {
  reloadInsights$,
  syncUsageRangeFromInsights$,
} from "./network-insights-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupNetworkInsightsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(NetworkInsightsPage), "sidebar");
    set(updateDocumentTitle$, "Insights & Usage");
    set(syncUsageRangeFromInsights$);
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
    set(reloadInsights$);
  },
);
