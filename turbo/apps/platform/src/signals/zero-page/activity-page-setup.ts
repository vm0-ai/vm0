import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityPageWrapper } from "../../views/zero-page/zero-activity-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "./zero-agents.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { switchActiveAgent$ } from "./zero-chat.ts";

export const setupActivityPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityPageWrapper));
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
    ]);
    signal.throwIfAborted();
    set(switchActiveAgent$, null);
  },
);
