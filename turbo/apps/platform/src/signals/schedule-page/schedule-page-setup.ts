import { command } from "ccstate";
import { createElement } from "react";
import { ZeroSchedulePageWrapper } from "../../views/schedule-page/zero-schedule-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { navigateTo$ } from "../route.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import {
  initZeroOnboarding$,
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { Reason, detach } from "../utils.ts";

export const setupSchedulePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroSchedulePageWrapper));
    set(updateDocumentTitle$, "Schedule");
    detach(set(fetchAllOrgSchedules$), Reason.Entrance);
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
    ]);
    signal.throwIfAborted();

    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const needsMemberOnboarding = await get(zeroNeedsMemberOnboarding$);
    signal.throwIfAborted();
    if (needsOnboarding || needsMemberOnboarding) {
      set(navigateTo$, "/onboarding", { replace: true });
      return;
    }

    set(switchActiveAgent$, null);
  },
);
