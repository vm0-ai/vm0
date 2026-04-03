import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroSchedulePage } from "../../views/zero-page/zero-schedule-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";
import { fetchAllOrgSchedules$ } from "../zero-page/zero-schedule.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupSchedulePage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(ZeroSchedulePage)),
    );
    set(updateDocumentTitle$, "Schedule");
    await Promise.all([
      set(fetchAllOrgSchedules$, signal),
      set(initZeroOnboarding$, signal),
    ]);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
  },
);
