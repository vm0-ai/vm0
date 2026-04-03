import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { QueuePage } from "../../views/queue-page/queue-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { logger } from "../log.ts";

import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";
import { startQueuePolling$ } from "./queue-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

const L = logger("QueuePage");

export const setupQueuePage$ = command(async ({ set }, signal: AbortSignal) => {
  set(
    updatePage$,
    createElement(SidebarLayout, null, createElement(QueuePage)),
  );
  set(updateDocumentTitle$, "Queue");
  await set(initZeroOnboarding$, signal);
  signal.throwIfAborted();
  await set(hideAppSkeleton$, signal);

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(reloadChatThreads$);
  // startQueuePolling$ is a long-running daemon loop — fire-and-forget so
  // the setup completes and the page renders.
  set(startQueuePolling$, signal).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") {
      return;
    }
    L.error("Queue polling failed", error);
  });
});
