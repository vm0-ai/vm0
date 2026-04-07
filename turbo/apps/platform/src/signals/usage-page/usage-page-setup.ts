import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { UsagePage } from "../../views/usage-page/usage-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupUsagePage$ = command(async ({ set }, signal: AbortSignal) => {
  set(
    updatePage$,
    createElement(SidebarLayout, null, createElement(UsagePage)),
  );
  set(updateDocumentTitle$, "Usage");
  await set(hideAppSkeleton$, signal);

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(reloadChatThreads$);
});
