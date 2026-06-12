import { command } from "ccstate";
import { createElement } from "react";
import { ZeroAutomationDetailPage } from "../../views/zero-page/zero-automation-detail-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { fetchAllOrgAutomations$ } from "../zero-page/zero-automations.ts";
import { fetchSlackChannels$ } from "../zero-page/slack-channels.ts";
import {
  setRunHistoryAutomationId$,
  seedAutomationRunCursorHistory$,
} from "./automation-run-history.ts";
import { initAutomationDetailTab$ } from "./automation-detail-tab.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupAutomationDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(updatePage$, createElement(ZeroAutomationDetailPage), "sidebar");
    set(initAutomationDetailTab$);

    // Initialize run history with the current automation ID from the URL
    const params = get(pathParams$);
    const scheduleId =
      params && typeof params === "object" && "scheduleId" in params
        ? String(params.scheduleId)
        : null;
    set(setRunHistoryAutomationId$, scheduleId);
    set(seedAutomationRunCursorHistory$);

    await Promise.all([
      set(fetchAllOrgAutomations$, signal),
      set(fetchSlackChannels$, signal),
    ]);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    set(reloadChatThreads$);
  },
);
