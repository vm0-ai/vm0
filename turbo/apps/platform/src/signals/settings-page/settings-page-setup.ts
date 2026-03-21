import { command } from "ccstate";
import { createElement } from "react";
import { ZeroSettingsPageWrapper } from "../../views/settings-page/zero-settings-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupSettingsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroSettingsPageWrapper));
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
    ]);
    signal.throwIfAborted();
    set(switchActiveAgent$, null);
  },
);
