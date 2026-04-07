import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroChatThreadPage } from "../../views/zero-page/zero-chat-thread-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  loadChatMessages$,
  resetLocalMessages$,
  chatThreads$,
} from "./chat-message.ts";
import {
  setChatAgentId$,
  currentChatThread$,
  currentChatThreadId$,
} from "../agent-chat.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { loadInitialData$ } from "../zero-page/zero-page.ts";
import { currentDraft$, ensureDraft$ } from "../zero-page/chat-draft.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      throw new Error("threadId is required to load chat page");
    }

    set(
      updatePage$,
      createElement(
        SidebarLayout,
        null,
        createElement(ZeroChatThreadPage, { key: threadId }),
      ),
    );
    set(updateDocumentTitle$, "Chat");

    await set(loadInitialData$, signal);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(resetLocalMessages$);

    if (!get(currentDraft$)) {
      set(ensureDraft$, threadId);
    }

    const sessions = await get(chatThreads$);
    signal.throwIfAborted();
    const session = sessions.find((s: { id: string }) => {
      return s.id === threadId;
    });
    const sessionTitle = session?.title ?? "New chat";
    set(updateDocumentTitle$, sessionTitle);

    const thread = await get(currentChatThread$);
    signal.throwIfAborted();
    set(setChatAgentId$, thread?.agentId ?? null);

    await set(loadChatMessages$, signal);
  },
);
