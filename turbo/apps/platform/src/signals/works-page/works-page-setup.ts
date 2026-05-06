import { command } from "ccstate";
import { createElement } from "react";
import { ZeroWorksPage } from "../../views/zero-page/zero-works-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import {
  initSlackOrg$,
  pollSlackConnection$,
} from "../zero-page/zero-slack.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupWorksPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroWorksPage), "sidebar");
  set(updateDocumentTitle$, "Works");
  set(initSlackOrg$);

  await Promise.all([
    set(hideAppSkeleton$, signal),
    set(onboardGuard$, signal),
    set(reloadChatThreads$),
    set(pollSlackConnection$, signal),
  ]);
});
