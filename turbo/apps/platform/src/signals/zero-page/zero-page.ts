import { command } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "./zero-agents.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { initZeroActivity$ } from "./zero-activity.ts";
import { Reason, detach } from "../utils.ts";

export const setupZeroPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroPage));

  await Promise.all([set(fetchAgentsList$), set(initZeroOnboarding$, signal)]);
  signal.throwIfAborted();
  detach(set(initZeroActivity$), Reason.Daemon);
});
