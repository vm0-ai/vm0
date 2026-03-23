import { command } from "ccstate";
import { createElement } from "react";
import { ZeroUsagePageWrapper } from "../../views/usage-page/zero-usage-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupUsagePage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroUsagePageWrapper));
  set(updateDocumentTitle$, "Usage");
  await Promise.all([set(fetchAgentsList$), set(initZeroOnboarding$, signal)]);
  signal.throwIfAborted();
  set(switchActiveAgent$, null);
});
