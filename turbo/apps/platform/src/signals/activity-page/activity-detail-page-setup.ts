import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityDetailPageWrapper } from "../../views/activity-page/zero-activity-detail-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { setupActivityLogLoop$ } from "./activity-signals.ts";

export const setupActivityDetailPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityDetailPageWrapper));
    set(updateDocumentTitle$, "Activity");

    await set(initZeroOnboarding$, signal);
    if (await set(onboardGuard$, signal)) {
      return;
    }

    await Promise.all([
      set(switchActiveAgent$, null, signal),
      set(setupActivityLogLoop$, signal),
    ]);
    signal.throwIfAborted();
  },
);
