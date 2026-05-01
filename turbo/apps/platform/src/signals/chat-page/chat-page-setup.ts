import { command } from "ccstate";
import { createElement } from "react";
import { ZeroChatThreadPage } from "../../views/zero-page/zero-chat-thread-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { searchParams$ } from "../route.ts";
import {
  SIDEBAR_PARAM,
  loadLeftThread$,
  loadRightThread$,
  unloadRightThread$,
} from "./chat-thread-panes.ts";
import {
  captureNavigationTiming$,
  markRouteSetupBegin$,
} from "../../lib/posthog.ts";

export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(markRouteSetupBegin$);
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      throw new Error("threadId is required to load chat page");
    }

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(updatePage$, createElement(ZeroChatThreadPage), "sidebar");
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
    set(captureNavigationTiming$);

    const sidebarThreadId = get(searchParams$).get(SIDEBAR_PARAM);
    const shouldLoadRight = sidebarThreadId && sidebarThreadId !== threadId;

    await Promise.all([
      set(loadLeftThread$, threadId, signal),
      shouldLoadRight
        ? set(loadRightThread$, sidebarThreadId, signal)
        : Promise.resolve(),
    ]);
    signal.throwIfAborted();

    if (sidebarThreadId && !shouldLoadRight) {
      // URL referenced sidebar thread that matched the primary thread —
      // strip it to keep state coherent.
      set(unloadRightThread$);
    }
  },
);
