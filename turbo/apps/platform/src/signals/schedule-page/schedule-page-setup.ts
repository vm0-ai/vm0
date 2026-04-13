import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroSchedulePage } from "../../views/zero-page/zero-schedule-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { initScheduleListTab$ } from "./schedule-list-tab.ts";
import { seedAllScheduleRunCursorHistory$ } from "./all-schedule-run-history.ts";

export const setupSchedulePage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(ZeroSchedulePage)),
    );
    set(updateDocumentTitle$, "Schedule");
    set(initScheduleListTab$);
    set(seedAllScheduleRunCursorHistory$);
    await set(fetchAllOrgSchedules$, signal);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
  },
);
