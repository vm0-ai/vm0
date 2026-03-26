import { command } from "ccstate";
import { createElement } from "react";
import { ZeroScheduleDetailPageWrapper } from "../../views/schedule-page/zero-schedule-detail-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { fetchSlackChannels$ } from "../zero-page/slack-channels.ts";
import { initSlackOrg$ } from "../zero-page/zero-slack.ts";
import { Reason, detach } from "../utils.ts";
import {
  setScheduleRunHistoryScheduleId$,
  seedScheduleRunCursorHistory$,
} from "./schedule-run-history.ts";
import { initScheduleDetailTab$ } from "./schedule-detail-tab.ts";

export const setupScheduleDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroScheduleDetailPageWrapper));
    set(initScheduleDetailTab$);

    // Initialize run history with the current schedule ID from the URL
    const params = get(pathParams$);
    const scheduleId =
      params && typeof params === "object" && "scheduleId" in params
        ? String(params.scheduleId)
        : null;
    set(setScheduleRunHistoryScheduleId$, scheduleId);
    set(seedScheduleRunCursorHistory$);

    detach(set(fetchAllOrgSchedules$, signal), Reason.Entrance);
    await Promise.all([
      set(initZeroOnboarding$, signal),
      set(initSlackOrg$, signal),
      set(fetchSlackChannels$, signal),
    ]);
    signal.throwIfAborted();
    await set(switchActiveAgent$, null, signal);
  },
);
