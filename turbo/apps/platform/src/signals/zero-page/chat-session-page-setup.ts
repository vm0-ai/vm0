import { command } from "ccstate";
import { createElement } from "react";
import { ZeroChatSessionPageWrapper } from "../../views/zero-page/zero-chat-session-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import {
  syncUrlSession$,
  prepareSessionSwitch$,
  zeroChatThreadId$,
} from "./zero-chat.ts";
import { zeroSessionId$ } from "./zero-nav.ts";
import { loadInitialData$ } from "./zero-page.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";

export const setupChatSessionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroChatSessionPageWrapper));

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

    await set(syncUrlSession$);
    signal.throwIfAborted();
    set(syncModelPreference$);
  },
);
