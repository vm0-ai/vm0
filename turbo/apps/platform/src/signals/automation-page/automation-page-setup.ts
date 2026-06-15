import { command } from "ccstate";
import { createElement } from "react";
import { ZeroAutomationsPage } from "../../views/zero-page/zero-automations-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { fetchAllOrgAutomations$ } from "../zero-page/zero-automations.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { initAutomationListTab$ } from "./automation-list-tab.ts";

export const setupAutomationsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroAutomationsPage), "sidebar");
    set(updateDocumentTitle$, "Automations");
    set(initAutomationListTab$);
    await set(fetchAllOrgAutomations$, signal);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
  },
);
