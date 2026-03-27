import { command } from "ccstate";
import { createElement } from "react";
import { ZeroWorksPageWrapper } from "../../views/works-page/zero-works-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import {
  initSlackOrg$,
  pollSlackConnection$,
} from "../zero-page/zero-slack.ts";

export const setupWorksPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroWorksPageWrapper));
  set(updateDocumentTitle$, "Works");
  await set(initSlackOrg$, signal);
  signal.throwIfAborted();
  detach(set(pollSlackConnection$, signal), Reason.Entrance);

  if (await set(onboardGuard$, signal)) {
    return;
  }

  await set(switchActiveAgent$, null, signal);
});
