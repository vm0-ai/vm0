import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroScheduleDetailPage } from "../../views/zero-page/zero-schedule-detail-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { fetchSlackChannels$ } from "../zero-page/slack-channels.ts";
import {
  setScheduleRunHistoryScheduleId$,
  seedScheduleRunCursorHistory$,
} from "./schedule-run-history.ts";
import { initScheduleDetailTab$ } from "./schedule-detail-tab.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupScheduleDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(ZeroScheduleDetailPage)),
    );
    set(initScheduleDetailTab$);

    // Initialize run history with the current schedule ID from the URL
    const params = get(pathParams$);
    const scheduleId =
      params && typeof params === "object" && "id" in params
        ? String(params.id)
        : null;
    set(setScheduleRunHistoryScheduleId$, scheduleId);
    set(seedScheduleRunCursorHistory$);

    await Promise.all([
      set(fetchAllOrgSchedules$, signal),
      set(fetchSlackChannels$, signal),
    ]);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    set(reloadChatThreads$);
  },
);
