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
import { chatThreadId$ } from "./zero-nav.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$ } from "./zero-page.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { detach, Reason } from "../utils.ts";

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

    // Update title with session preview
    const sessionId = get(chatThreadId$);
    if (sessionId) {
      const sessions = await get(zeroSessionList$);
      signal.throwIfAborted();
      const session = sessions.find((s: { id: string }) => s.id === sessionId);
      const sessionTitle = session?.preview ?? "New chat";
      set(updateDocumentTitle$, sessionTitle);
    }

    set(syncModelPreference$);

    // chatSessionSnapshot$ auto-fetches from URL. loadSessionFromSnapshot$
    // awaits it, populates server messages, syncs agent, resumes polling.
    detach(set(loadSessionFromSnapshot$, signal), Reason.Entrance);
  },
);
