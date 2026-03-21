import { command } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupQueuePage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroPage));
  await Promise.all([set(fetchAgentsList$), set(initZeroOnboarding$, signal)]);
  signal.throwIfAborted();
  set(switchActiveAgent$, null);
});
