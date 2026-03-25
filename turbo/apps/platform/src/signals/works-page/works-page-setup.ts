import { command } from "ccstate";
import { createElement } from "react";
import { ZeroWorksPageWrapper } from "../../views/works-page/zero-works-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import {
  initSlackOrg$,
  pollSlackConnection$,
} from "../zero-page/zero-slack.ts";
import {
  initTelegramOrg$,
  pollTelegramConnection$,
} from "../zero-page/zero-telegram.ts";

export const setupWorksPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroWorksPageWrapper));
  set(updateDocumentTitle$, "Works");
  await Promise.all([
    set(fetchAgentsList$),
    set(initZeroOnboarding$, signal),
    set(initSlackOrg$),
    set(initTelegramOrg$),
  ]);
  signal.throwIfAborted();
  detach(set(pollSlackConnection$, signal), Reason.Entrance);
  detach(set(pollTelegramConnection$, signal), Reason.Entrance);

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(switchActiveAgent$, null);
});
