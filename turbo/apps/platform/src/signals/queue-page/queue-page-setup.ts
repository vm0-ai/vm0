import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { QueuePage } from "../../views/queue-page/queue-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";
import { startQueuePolling$ } from "./queue-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

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
  // eslint-disable-next-line ccstate/no-detach-in-signals -- TODO: move to views layer
  detach(set(startQueuePolling$, signal), Reason.Entrance);
});
