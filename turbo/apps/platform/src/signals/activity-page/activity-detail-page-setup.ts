import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroActivityDetailPage } from "../../views/zero-page/zero-activity-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { setupActivityLogLoop$ } from "./activity-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupActivityDetailPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(ZeroActivityDetailPage)),
    );
    set(updateDocumentTitle$, "Activity");

    await set(hideAppSkeleton$, signal);
    if (await set(onboardGuard$, signal)) {
      return;
    }

    await Promise.all([
      set(setupActivityLogLoop$, signal),
      set(reloadChatThreads$),
    ]);
    signal.throwIfAborted();
  },
);
