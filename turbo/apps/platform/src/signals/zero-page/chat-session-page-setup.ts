import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroChatThreadPage } from "../../views/zero-page/zero-chat-thread-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  loadSessionFromSnapshot$,
  resetLocalMessages$,
  chatThreads$,
} from "./zero-chat.ts";
import { chatThreadId$, setSidebarChatAgent$ } from "./zero-nav.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$ } from "./zero-page.ts";

import { zeroChatAgentId$ } from "./zero-active-agent.ts";
import { currentDraft$, ensureDraft$ } from "./chat-draft.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupChatSessionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const threadId = get(chatThreadId$);
    set(
      updatePage$,
      createElement(
        SidebarLayout,
        null,
        threadId ? createElement(ZeroChatThreadPage, { key: threadId }) : null,
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

    // Ensure a draft exists for this thread
    if (threadId && !get(currentDraft$)) {
      set(ensureDraft$, threadId);
    }

    // Update title with session name
    const sessionId = get(chatThreadId$);
    if (sessionId) {
      const sessions = await get(chatThreads$);
      signal.throwIfAborted();
      const session = sessions.find((s: { id: string }) => {
        return s.id === sessionId;
      });
      const sessionTitle = session?.title ?? "New chat";
      set(updateDocumentTitle$, sessionTitle);
    }

    // Sync sidebar agent from thread data so it persists on non-chat pages.
    const chatAgentId = await get(zeroChatAgentId$);
    signal.throwIfAborted();
    set(setSidebarChatAgent$, chatAgentId);

    await set(loadSessionFromSnapshot$, signal);
  },
);
