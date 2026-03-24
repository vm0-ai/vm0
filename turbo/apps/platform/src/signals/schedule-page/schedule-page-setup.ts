import { command } from "ccstate";
import { createElement } from "react";
import { ZeroSchedulePageWrapper } from "../../views/schedule-page/zero-schedule-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { initSlackOrg$ } from "../zero-page/zero-slack.ts";
import { Reason, detach } from "../utils.ts";

export const setupSchedulePage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroSchedulePageWrapper));
    set(updateDocumentTitle$, "Schedule");
    detach(set(fetchAllOrgSchedules$), Reason.Entrance);
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      set(initSlackOrg$),
    ]);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(switchActiveAgent$, null);
  },
);
