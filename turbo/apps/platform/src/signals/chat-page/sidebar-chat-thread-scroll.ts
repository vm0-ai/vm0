import { command, computed } from "ccstate";
import { animationFrame } from "signal-timers";
import { createDeferredPromise, onRef } from "../utils.ts";
import {
  CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  chatThreadVirtualListElement$,
  getChatThreadVirtualListScrollMargin,
  overlayScrollMetrics$,
  overlayScrollViewport$,
  scrollChatThreadVirtualListToIndex$,
  type ChatThreadVirtualListScrollAlign,
} from "../zero-page/zero-sidebar-state.ts";
import {
  chatThreads$,
  currentChatThreadId$,
  currentChatThreadListIds$,
} from "../agent-chat.ts";
import {
  sidebarChatThreadItemSignalsRegistry$,
  type SidebarChatThreadItemSignals,
} from "./sidebar-chat-thread-item.ts";

const CHAT_THREAD_VIRTUAL_OVERSCAN = 8;

export interface SidebarChatThreadWindow {
  readonly startIndex: number;
  readonly items: readonly SidebarChatThreadItemSignals[];
}

function getFixedVirtualRange({
  itemCount,
  scrollMargin,
  scrollTop,
  viewportHeight,
}: {
  itemCount: number;
  scrollMargin: number;
  scrollTop: number;
  viewportHeight: number;
}) {
  const localScrollTop = Math.max(0, scrollTop - scrollMargin);
  const firstVisibleIndex = Math.floor(
    localScrollTop / CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  );
  const visibleCount = Math.max(
    1,
    Math.ceil(viewportHeight / CHAT_THREAD_VIRTUAL_ROW_HEIGHT),
  );
  const startIndex = Math.max(
    0,
    firstVisibleIndex - CHAT_THREAD_VIRTUAL_OVERSCAN,
  );
  const endIndex = Math.min(
    itemCount,
    firstVisibleIndex + visibleCount + CHAT_THREAD_VIRTUAL_OVERSCAN,
  );

  return { startIndex, endIndex };
}

export const sidebarChatThreadCount$ = computed(
  async (get): Promise<number> => {
    return (await get(currentChatThreadListIds$)).length;
  },
);

export const currentChatThreadListed$ = computed(
  async (get): Promise<boolean> => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      return false;
    }
    return (await get(currentChatThreadListIds$)).includes(threadId);
  },
);

export const sidebarChatThreadWindow$ = computed(
  async (get): Promise<SidebarChatThreadWindow> => {
    const chatThreads = await get(chatThreads$);
    const scrollViewport = get(overlayScrollViewport$);
    const scrollMetrics = get(overlayScrollMetrics$);
    const virtualListElement = get(chatThreadVirtualListElement$);
    const scrollMargin = getChatThreadVirtualListScrollMargin(
      scrollViewport,
      virtualListElement,
    );
    const viewportHeight =
      scrollMetrics.clientHeight ||
      scrollViewport?.clientHeight ||
      CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT;
    const scrollTop = scrollMetrics.scrollTop ?? scrollViewport?.scrollTop ?? 0;
    const { startIndex, endIndex } = getFixedVirtualRange({
      itemCount: chatThreads.length,
      scrollMargin,
      scrollTop,
      viewportHeight,
    });
    const itemSignals = get(sidebarChatThreadItemSignalsRegistry$).reconcile(
      chatThreads.map((thread) => {
        return thread.id;
      }),
    );

    return {
      startIndex,
      items: itemSignals.slice(startIndex, endIndex),
    };
  },
);

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
    const threadIds = await get(currentChatThreadListIds$);
    signal.throwIfAborted();

    const index = threadIds.indexOf(threadId);
    if (index === -1) {
      return false;
    }

    await waitForAnimationFrame(signal);
    signal.throwIfAborted();
    return set(scrollChatThreadVirtualListToIndex$, index, align);
  },
);

export const scrollCurrentChatThreadOnRef$ = onRef(
  command(async ({ set }, element: HTMLSpanElement, signal: AbortSignal) => {
    const threadId = element.dataset.chatThreadId;
    if (!threadId) {
      return;
    }
    await set(scrollToThread$, { threadId, align: "top" }, signal);
  }),
);
