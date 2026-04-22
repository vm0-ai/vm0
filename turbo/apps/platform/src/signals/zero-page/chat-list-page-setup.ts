import { command } from "ccstate";
import { createElement } from "react";
import { ZeroChatListPage } from "../../views/zero-page/zero-chat-list-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { setChatAgentId$ } from "../agent-chat.ts";

export const setupChatListPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const agentId = params.get("agentId");

    set(updatePage$, createElement(ZeroChatListPage), "sidebar");
    set(updateDocumentTitle$, "Chats");

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    if (agentId) {
      set(setChatAgentId$, agentId);
    }
  },
);
