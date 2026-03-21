import { command } from "ccstate";
import { createElement } from "react";
import { ZeroSchedulePageWrapper } from "../../views/schedule-page/zero-schedule-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { Reason, detach } from "../utils.ts";

export const setupSchedulePage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroSchedulePageWrapper));
    detach(set(fetchAllOrgSchedules$), Reason.Entrance);
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
    ]);
    signal.throwIfAborted();
    set(switchActiveAgent$, null);
  },
);
