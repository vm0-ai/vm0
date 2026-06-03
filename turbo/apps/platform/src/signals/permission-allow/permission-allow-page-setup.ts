import { command } from "ccstate";
import { createElement } from "react";
import { PermissionAllowPage } from "../../views/permission-allow/permission-allow-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { currentAgentId$, rememberLastUsedAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupPermissionAllowPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(PermissionAllowPage), "minimal");
    set(updateDocumentTitle$, "Permissions");

    const agentId = get(currentAgentId$);
    if (agentId) {
      set(rememberLastUsedAgentId$, agentId);
    }

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
  },
);
