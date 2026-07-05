import { command } from "ccstate";
import { animationFrame } from "signal-timers";
import { createDeferredPromise } from "../utils.ts";
import {
  scrollChatThreadVirtualListToIndex$,
  type ChatThreadVirtualListScrollAlign,
} from "../zero-page/zero-sidebar-state.ts";
import { sidebarChatThreads$ } from "./optimistic-chat-thread-page.ts";

interface ScrollToThreadRequest {
  threadId: string;
  align?: ChatThreadVirtualListScrollAlign;
}

async function waitForAnimationFrame(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const deferred = createDeferredPromise<void>(signal);
  animationFrame(
    () => {
      if (!deferred.settled()) {
        deferred.resolve(undefined);
      }
    },
    { signal },
  );
  await deferred.promise;
}

export const scrollToThread$ = command(
  async (
    { get, set },
    request: string | ScrollToThreadRequest,
    signal: AbortSignal,
  ) => {
    const threadId = typeof request === "string" ? request : request.threadId;
    const align = typeof request === "string" ? "top" : request.align;
    const chatThreads = await get(sidebarChatThreads$);
    signal.throwIfAborted();

    const index = chatThreads.findIndex((thread) => {
      return thread.id === threadId;
    });
    if (index === -1) {
      return false;
    }

    await waitForAnimationFrame(signal);
    signal.throwIfAborted();
    return set(scrollChatThreadVirtualListToIndex$, index, align);
  },
);
