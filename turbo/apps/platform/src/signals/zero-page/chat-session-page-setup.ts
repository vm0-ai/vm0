import { command } from "ccstate";
import { createElement } from "react";
import { ZeroChatSessionPageWrapper } from "../../views/zero-page/zero-chat-session-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "./zero-agents.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { syncUrlSession$ } from "./zero-chat.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";

export const setupChatSessionPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroChatSessionPageWrapper));
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
    ]);
    signal.throwIfAborted();

    await set(syncUrlSession$);
    signal.throwIfAborted();
    set(syncModelPreference$);
  },
);
