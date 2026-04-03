import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroWorksPage } from "../../views/zero-page/zero-works-page.tsx";
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
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupWorksPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(
    updatePage$,
    createElement(SidebarLayout, null, createElement(ZeroWorksPage)),
  );
  set(updateDocumentTitle$, "Works");
  await Promise.all([
    set(initZeroOnboarding$, signal),
    set(initSlackOrg$, signal),
  ]);
  signal.throwIfAborted();
  await set(hideAppSkeleton$, signal);
  // eslint-disable-next-line ccstate/no-detach-in-signals -- TODO: move to views layer
  detach(set(pollSlackConnection$, signal), Reason.Entrance);

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(reloadChatThreads$);
});
