import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { LabPage } from "../../views/lab-page/lab-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupLabPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(SidebarLayout, null, createElement(LabPage)));
  set(updateDocumentTitle$, "Lab");
  await set(initZeroOnboarding$, signal);
  signal.throwIfAborted();
  await set(hideAppSkeleton$, signal);

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(reloadChatThreads$);
});
