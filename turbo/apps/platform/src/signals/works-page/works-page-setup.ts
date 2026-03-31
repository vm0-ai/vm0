import { command } from "ccstate";
import { createElement } from "react";
import { ZeroWorksPageWrapper } from "../../views/works-page/zero-works-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";
import {
  initSlackOrg$,
  pollSlackConnection$,
} from "../zero-page/zero-slack.ts";

export const setupWorksPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroWorksPageWrapper));
  set(updateDocumentTitle$, "Works");
  await Promise.all([
    set(initZeroOnboarding$, signal),
    set(initSlackOrg$, signal),
  ]);
  signal.throwIfAborted();
  detach(set(pollSlackConnection$, signal), Reason.Entrance);

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(reloadChatThreads$);
});
