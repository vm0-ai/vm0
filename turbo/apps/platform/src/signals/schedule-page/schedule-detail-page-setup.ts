import { command } from "ccstate";
import { createElement } from "react";
import { ZeroScheduleDetailPageWrapper } from "../../views/schedule-page/zero-schedule-detail-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { fetchSlackChannels$ } from "../zero-page/slack-channels.ts";
import { initSlackOrg$ } from "../zero-page/zero-slack.ts";
import { Reason, detach } from "../utils.ts";

export const setupScheduleDetailPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroScheduleDetailPageWrapper));
    detach(set(fetchAllOrgSchedules$), Reason.Entrance);
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      set(initSlackOrg$),
      set(fetchSlackChannels$),
    ]);
    signal.throwIfAborted();
    set(switchActiveAgent$, null);
  },
);
