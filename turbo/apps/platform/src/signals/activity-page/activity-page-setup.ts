import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityPageWrapper } from "../../views/activity-page/zero-activity-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { initZeroActivity$, refreshZeroActivity$ } from "./activity-signals.ts";

export const setupActivityPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityPageWrapper));
    set(updateDocumentTitle$, "Activity");
    set(refreshZeroActivity$);
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      set(initZeroActivity$),
    ]);
    signal.throwIfAborted();
    set(switchActiveAgent$, null);
  },
);
