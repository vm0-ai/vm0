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
import { reloadUserModelPreference$ } from "../external/user-model-preference.ts";

const internalSetupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(markRouteSetupBegin$);
    set(reloadUserModelPreference$);
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      throw new Error("threadId is required to load chat page");
    }

    set(updatePage$, createElement(ZeroChatThreadPage), "sidebar");

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
      set(unloadRightThread$);
    }
  },
);

export const setupChatPage$ = command(async ({ set }, signal: AbortSignal) => {
  await Promise.all([
    set(onboardGuard$, signal),
    set(internalSetupChatPage$, signal),
    set(hideAppSkeleton$, signal),
  ]);
  signal.throwIfAborted();
});
