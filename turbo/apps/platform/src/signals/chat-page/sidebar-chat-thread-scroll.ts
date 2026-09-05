import { command, computed, state, type Command, type Computed } from "ccstate";
import { animationFrame } from "signal-timers";
import { createDeferredPromise, onRef } from "../utils.ts";
import {
  CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  type ChatThreadVirtualListScrollAlign,
} from "../okou-page/sidebar-state.ts";
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
const CHAT_THREAD_VIRTUAL_FALLBACK_WINDOW_SIZE = 100;

export interface SidebarChatThreadWindow {
  readonly startIndex: number;
  readonly items: readonly SidebarChatThreadItemSignals[];
}

export interface SidebarChatThreadScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface SidebarChatThreadScrollThumbStyle {
  readonly top: number;
  readonly height: number;
  readonly visible: boolean;
}

export interface ScrollToThreadRequest {
  readonly threadId: string;
  readonly align?: ChatThreadVirtualListScrollAlign;
}

export interface SidebarChatThreadScrollSignals {
  readonly isScrolled$: Computed<boolean>;
  readonly thumbStyle$: Computed<SidebarChatThreadScrollThumbStyle>;
  readonly window$: Computed<Promise<SidebarChatThreadWindow>>;
  readonly setScrollMetrics$: Command<void, [SidebarChatThreadScrollMetrics]>;
  readonly setScrollViewport$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly scrollToThread$: Command<
    Promise<boolean>,
    [string | ScrollToThreadRequest, AbortSignal]
  >;
  readonly scrollCurrentChatThreadOnRef$: Command<
    (() => void) | undefined,
    [HTMLSpanElement | null]
  >;
}

function emptyScrollMetrics(): SidebarChatThreadScrollMetrics {
  return {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
}

function getScrollThumbStyle({
  scrollTop,
  scrollHeight,
  clientHeight,
}: SidebarChatThreadScrollMetrics): SidebarChatThreadScrollThumbStyle {
  if (scrollHeight <= clientHeight) {
    return { top: 0, height: 0, visible: false };
  }
  const ratio = clientHeight / scrollHeight;
  const height = Math.max(ratio * clientHeight, 24);
  const maxTop = clientHeight - height;
  const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
  return { top, height, visible: true };
}

function createSidebarChatThreadDomSignals() {
  const internalScrollViewport$ = state<HTMLElement | null>(null);
  const internalScrollMetrics$ =
    state<SidebarChatThreadScrollMetrics>(emptyScrollMetrics());

  const scrollViewport$ = computed((get) => {
    return get(internalScrollViewport$);
  });
  const scrollMetrics$ = computed((get) => {
    return get(internalScrollMetrics$);
  });
  const isScrolled$ = computed((get) => {
    return get(internalScrollMetrics$).scrollTop > 0;
  });
  const thumbStyle$ = computed((get) => {
    return getScrollThumbStyle(get(internalScrollMetrics$));
  });

  const measureScrollViewport$ = command(({ set }, viewport: HTMLElement) => {
    set(internalScrollMetrics$, {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    });
  });
  const clearScrollViewport$ = command(
    ({ get, set }, viewport: HTMLElement) => {
      if (get(internalScrollViewport$) !== viewport) {
        return;
      }
      set(internalScrollViewport$, null);
      set(internalScrollMetrics$, emptyScrollMetrics());
    },
  );
  const setScrollViewport$ = onRef(
    command(({ set }, viewport: HTMLElement, signal: AbortSignal) => {
      set(internalScrollViewport$, viewport);
      set(measureScrollViewport$, viewport);
      // Async stylesheet activation can change the viewport without scrolling.
      const resizeObserver = new ResizeObserver(() => {
        set(measureScrollViewport$, viewport);
      });
      resizeObserver.observe(viewport);
      signal.addEventListener(
        "abort",
        () => {
          resizeObserver.disconnect();
          set(clearScrollViewport$, viewport);
        },
        { once: true },
      );
    }),
  );
  const setScrollMetrics$ = command(
    ({ set }, metrics: SidebarChatThreadScrollMetrics) => {
      set(internalScrollMetrics$, metrics);
    },
  );

  return {
    isScrolled$,
    thumbStyle$,
    scrollViewport$,
    scrollMetrics$,
    setScrollViewport$,
    setScrollMetrics$,
  };
}

type SidebarChatThreadDomSignals = ReturnType<
  typeof createSidebarChatThreadDomSignals
>;

function getFixedVirtualRange({
  itemCount,
  scrollTop,
  viewportHeight,
}: {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
}) {
  const requestedFirstVisibleIndex = Math.floor(
    Math.max(0, scrollTop) / CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  );
  const visibleCount = Math.max(
    1,
    Math.ceil(viewportHeight / CHAT_THREAD_VIRTUAL_ROW_HEIGHT),
  );
  const firstVisibleIndex = Math.min(
    requestedFirstVisibleIndex,
    Math.max(0, itemCount - visibleCount),
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

function createSidebarChatThreadWindowSignal(
  dom: SidebarChatThreadDomSignals,
): Computed<Promise<SidebarChatThreadWindow>> {
  return computed(async (get): Promise<SidebarChatThreadWindow> => {
    const chatThreads = await get(chatThreads$);
    const scrollViewport = get(dom.scrollViewport$);
    const scrollMetrics = get(dom.scrollMetrics$);
    const measuredViewportHeight =
      scrollMetrics.clientHeight || scrollViewport?.clientHeight;
    const viewportHeight =
      measuredViewportHeight || CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT;
    const scrollTop = scrollViewport?.scrollTop ?? scrollMetrics.scrollTop;
    const { startIndex, endIndex } = getFixedVirtualRange({
      itemCount: chatThreads.length,
      scrollTop,
      viewportHeight,
    });
    const resolvedEndIndex = measuredViewportHeight
      ? endIndex
      : Math.min(
          chatThreads.length,
          Math.max(
            endIndex,
            startIndex + CHAT_THREAD_VIRTUAL_FALLBACK_WINDOW_SIZE,
          ),
        );
    const itemSignals = get(sidebarChatThreadItemSignalsRegistry$).reconcile(
      chatThreads.map((thread) => {
        return thread.id;
      }),
    );

    return {
      startIndex,
      items: itemSignals.slice(startIndex, resolvedEndIndex),
    };
  });
}

function createScrollVirtualListToIndexCommand(
  dom: SidebarChatThreadDomSignals,
) {
  return command(
    (
      { get, set },
      index: number,
      align: ChatThreadVirtualListScrollAlign = "top",
    ): boolean => {
      if (!Number.isInteger(index) || index < 0) {
        return false;
      }

      const scrollViewport = get(dom.scrollViewport$);
      if (!scrollViewport) {
        return false;
      }

      const currentMetrics = get(dom.scrollMetrics$);
      const viewportHeight =
        currentMetrics.clientHeight ||
        scrollViewport.clientHeight ||
        CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT;
      const rowTop = index * CHAT_THREAD_VIRTUAL_ROW_HEIGHT;
      const rowBottom = rowTop + CHAT_THREAD_VIRTUAL_ROW_HEIGHT;
      const viewportTop = scrollViewport.scrollTop;
      const viewportBottom = viewportTop + viewportHeight;
      let nextScrollTop = viewportTop;
      if (rowBottom > viewportBottom) {
        nextScrollTop =
          align === "bottom"
            ? Math.max(0, rowBottom - viewportHeight)
            : Math.max(0, rowTop);
      } else if (rowTop < viewportTop) {
        nextScrollTop = Math.max(0, rowTop);
      }

      scrollViewport.scrollTop = nextScrollTop;
      set(dom.setScrollMetrics$, {
        scrollTop: nextScrollTop,
        scrollHeight: scrollViewport.scrollHeight,
        clientHeight: scrollViewport.clientHeight,
      });
      return true;
    },
  );
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

function createSidebarChatThreadScrollSignals(): SidebarChatThreadScrollSignals {
  const dom = createSidebarChatThreadDomSignals();
  const scrollVirtualListToIndex$ = createScrollVirtualListToIndexCommand(dom);
  const scrollToThread$ = command(
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
      return set(scrollVirtualListToIndex$, index, align);
    },
  );
  const scrollCurrentChatThreadOnRef$ = onRef(
    command(async ({ set }, element: HTMLSpanElement, signal: AbortSignal) => {
      const threadId = element.dataset.chatThreadId;
      if (!threadId) {
        return;
      }
      await set(scrollToThread$, { threadId, align: "top" }, signal);
    }),
  );

  return {
    isScrolled$: dom.isScrolled$,
    thumbStyle$: dom.thumbStyle$,
    window$: createSidebarChatThreadWindowSignal(dom),
    setScrollMetrics$: dom.setScrollMetrics$,
    setScrollViewport$: dom.setScrollViewport$,
    scrollToThread$,
    scrollCurrentChatThreadOnRef$,
  };
}

export const responsiveSidebarChatThreadScrollSignals =
  createSidebarChatThreadScrollSignals();
export const threeColumnSidebarChatThreadScrollSignals =
  createSidebarChatThreadScrollSignals();

export const scrollToThread$ = command(
  async (
    { set },
    request: string | ScrollToThreadRequest,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const responsiveScroll = set(
      responsiveSidebarChatThreadScrollSignals.scrollToThread$,
      request,
      signal,
    );
    const threeColumnScroll = set(
      threeColumnSidebarChatThreadScrollSignals.scrollToThread$,
      request,
      signal,
    );
    const [responsiveScrolled, threeColumnScrolled] = await Promise.all([
      responsiveScroll,
      threeColumnScroll,
    ]);
    signal.throwIfAborted();
    return responsiveScrolled || threeColumnScrolled;
  },
);
