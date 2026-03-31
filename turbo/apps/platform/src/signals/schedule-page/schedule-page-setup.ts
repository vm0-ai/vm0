import { command } from "ccstate";
import { createElement } from "react";
import { ZeroSchedulePageWrapper } from "../../views/schedule-page/zero-schedule-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { Reason, detach } from "../utils.ts";

export const setupSchedulePage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroSchedulePageWrapper));
    set(updateDocumentTitle$, "Schedule");
    detach(set(fetchAllOrgSchedules$, signal), Reason.Entrance);
    await set(initZeroOnboarding$, signal);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
  },
);
