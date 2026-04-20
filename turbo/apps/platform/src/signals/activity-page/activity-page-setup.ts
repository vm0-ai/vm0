import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroActivityPage } from "../../views/zero-page/zero-activity-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { initZeroActivity$, refreshZeroActivity$ } from "./activity-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupActivityPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(ZeroActivityPage)),
    );
    set(updateDocumentTitle$, "Activity");
    set(refreshZeroActivity$);
    await set(initZeroActivity$, signal);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
  },
);
