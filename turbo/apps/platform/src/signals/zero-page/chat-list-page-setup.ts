import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroChatListPage } from "../../views/zero-page/zero-chat-list-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { setSidebarChatAgent$ } from "./zero-nav.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$ } from "./zero-page.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupChatListPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const agentId = params.get("agentId");

    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(ZeroChatListPage)),
    );
    set(updateDocumentTitle$, "Chats");

    await set(loadInitialData$, signal);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    if (agentId) {
      set(setSidebarChatAgent$, agentId);
    }
  },
);
