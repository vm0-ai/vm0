import { command } from "ccstate";
import { createElement } from "react";
import { ZeroChatSessionPageWrapper } from "../../views/zero-page/zero-chat-session-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  syncUrlSession$,
  prepareSessionSwitch$,
  zeroChatThreadId$,
  zeroSessionList$,
} from "./zero-chat.ts";
import { zeroSessionId$ } from "./zero-nav.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$ } from "./zero-page.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";

export const setupChatSessionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroChatSessionPageWrapper));
    set(updateDocumentTitle$, "Chat");

    // Show skeleton only when the URL points to a different thread than
    // what's already loaded.  This covers page refresh (threadId is null)
    // and sidebar navigation (threadId differs).  When arriving from
    // /talk after sending a message the thread is already set and messages
    // are in-flight, so we must NOT clear them.
    if (get(zeroSessionId$) !== get(zeroChatThreadId$)) {
      set(prepareSessionSwitch$);
    }

    await set(loadInitialData$, signal);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(syncUrlSession$);
    signal.throwIfAborted();

    // Update title with session preview
    const sessionId = get(zeroSessionId$);
    if (sessionId) {
      const sessions = get(zeroSessionList$);
      const session = sessions.find((s) => s.id === sessionId);
      const sessionTitle = session?.preview ?? "New chat";
      set(updateDocumentTitle$, sessionTitle);
    }

    set(syncModelPreference$);
  },
);
