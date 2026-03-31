import { command } from "ccstate";
import { createElement } from "react";
import { ZeroChatSessionPageWrapper } from "../../views/zero-page/zero-chat-session-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  loadSessionFromSnapshot$,
  resetLocalMessages$,
  zeroSessionList$,
} from "./zero-chat.ts";
import { chatThreadId$, setSidebarChatAgent$ } from "./zero-nav.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$ } from "./zero-page.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { detach, Reason } from "../utils.ts";
import { zeroChatAgentId$ } from "./zero-active-agent.ts";
import { currentDraft$, ensureDraft$ } from "./chat-draft.ts";

export const setupChatSessionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroChatSessionPageWrapper));
    set(updateDocumentTitle$, "Chat");

    await set(loadInitialData$, signal);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(resetLocalMessages$);

    // Ensure a draft exists for this thread
    const threadId = get(chatThreadId$);
    if (threadId && !get(currentDraft$)) {
      set(ensureDraft$, threadId);
    }

    // Update title with session name
    const sessionId = get(chatThreadId$);
    if (sessionId) {
      const sessions = await get(zeroSessionList$);
      signal.throwIfAborted();
      const session = sessions.find((s: { id: string }) => {
        return s.id === sessionId;
      });
      const sessionTitle = session?.title ?? "New chat";
      set(updateDocumentTitle$, sessionTitle);
    }

    set(syncModelPreference$);

    // Sync sidebar agent from thread data so it persists on non-chat pages.
    const chatAgentId = await get(zeroChatAgentId$);
    signal.throwIfAborted();
    set(setSidebarChatAgent$, chatAgentId);

    // chatSessionSnapshot$ auto-fetches from URL. loadSessionFromSnapshot$
    // awaits it, populates server messages, syncs agent, resumes polling.
    detach(set(loadSessionFromSnapshot$, signal), Reason.Entrance);
  },
);
