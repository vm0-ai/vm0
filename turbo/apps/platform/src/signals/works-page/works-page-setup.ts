import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroWorksPage } from "../../views/zero-page/zero-works-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { logger } from "../log.ts";

import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import {
  initSlackOrg$,
  pollSlackConnection$,
} from "../zero-page/zero-slack.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

const L = logger("WorksPage");

export const setupWorksPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(
    updatePage$,
    createElement(SidebarLayout, null, createElement(ZeroWorksPage)),
  );
  set(updateDocumentTitle$, "Works");
  set(initSlackOrg$);
  await set(initZeroOnboarding$, signal);
  signal.throwIfAborted();
  await set(hideAppSkeleton$, signal);
  // pollSlackConnection$ is a long-running daemon loop — fire-and-forget so
  // the setup completes and the page renders.
  set(pollSlackConnection$, signal).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") {
      return;
    }
    L.error("Slack polling failed", error);
  });

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(reloadChatThreads$);
});
