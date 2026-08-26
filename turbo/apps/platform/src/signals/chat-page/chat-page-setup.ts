import { command } from "ccstate";
import { createElement } from "react";
import { ChatThreadPage } from "../../views/okou-page/chat-thread-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { onboardGuard$ } from "../okou-page/onboard-guard.ts";
import { searchParams$ } from "../route.ts";
import {
  SIDEBAR_PARAM,
  setupLeftThread$,
  setupLeftThreadNotFound$,
  setupRightThread$,
  setupRightThreadNotFound$,
  unloadRightThread$,
} from "./chat-thread-panes.ts";
import { resolvedThreadMeta } from "./chat-thread-event-sourcing.ts";
import {
  captureNavigationTiming$,
  markRouteSetupBegin$,
  recordBootstrapThreadMetadataTiming$,
} from "../../lib/posthog.ts";

const setupResolvedLeftThread$ = command(
  async (
    { get, set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const resolution = await get(resolvedThreadMeta(threadId));
    signal.throwIfAborted();
    set(recordBootstrapThreadMetadataTiming$, {
      localDurationMs: resolution.localDurationMs,
      remoteDurationMs: resolution.remoteDurationMs,
      source: resolution.source,
    });
    const { meta } = resolution;
    if (meta) {
      await set(setupLeftThread$, meta, signal);
      return;
    }
    await set(setupLeftThreadNotFound$, threadId, signal);
  },
);

const setupResolvedRightThread$ = command(
  async (
    { get, set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const { meta } = await get(resolvedThreadMeta(threadId));
    signal.throwIfAborted();
    if (meta) {
      await set(setupRightThread$, meta, signal);
      return;
    }
    await set(setupRightThreadNotFound$, threadId, signal);
  },
);

const internalSetupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(markRouteSetupBegin$);
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      throw new Error("threadId is required to load chat page");
    }

    set(updatePage$, createElement(ChatThreadPage), "sidebar");

    set(captureNavigationTiming$);

    const sidebarThreadId = get(searchParams$).get(SIDEBAR_PARAM);
    const rightThreadId =
      sidebarThreadId && sidebarThreadId !== threadId ? sidebarThreadId : null;

    await Promise.all([
      set(setupResolvedLeftThread$, threadId, signal),
      rightThreadId
        ? set(setupResolvedRightThread$, rightThreadId, signal)
        : set(unloadRightThread$),
    ]);
    signal.throwIfAborted();
  },
);

export const setupChatPage$ = command(async ({ set }, signal: AbortSignal) => {
  await Promise.all([
    set(onboardGuard$, signal),
    set(internalSetupChatPage$, signal),
  ]);
  signal.throwIfAborted();
});
