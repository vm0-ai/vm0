import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityPageWrapper } from "../../views/activity-page/zero-activity-page-wrapper.tsx";
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
import { initZeroActivity$, refreshZeroActivity$ } from "./activity-signals.ts";

export const setupActivityPage$ = command(
  async ({ set, get }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityPageWrapper));
    set(updateDocumentTitle$, "Activity");
    set(refreshZeroActivity$);
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      set(initZeroActivity$),
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
