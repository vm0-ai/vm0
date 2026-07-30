import { command, computed, state, type Command, type Computed } from "ccstate";
import { animationFrame } from "signal-timers";
import { onRef } from "../utils.ts";

const AT_BOTTOM_THRESHOLD_PX = 10;
const SCROLL_ANCHOR_ATTRIBUTE = "data-chat-scroll-anchor-event-id";

export interface ThreadScrollPosition {
  readonly targetEventId: string;
  readonly viewportOffsetTop: number;
}

interface ChatThreadScrollSignals {
  readonly scrollContainerOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
  readonly scrollTo$: Command<boolean, [ThreadScrollPosition]>;
  readonly scrollToTop$: Command<void, []>;
  readonly scrollToBottom$: Command<void, []>;
}

const threadScrollPositions$ = state(new Map<string, ThreadScrollPosition>());

function isAtBottom(container: HTMLElement): boolean {
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <=
    AT_BOTTOM_THRESHOLD_PX
  );
}

function scrollAnchors(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`[${SCROLL_ANCHOR_ATTRIBUTE}]`),
  );
}

function scrollAnchorForEvent(
  container: HTMLElement,
  eventId: string,
): HTMLElement | null {
  return (
    scrollAnchors(container).find((anchor) => {
      return anchor.getAttribute(SCROLL_ANCHOR_ATTRIBUTE) === eventId;
    }) ?? null
  );
}

function firstVisibleScrollAnchor(container: HTMLElement): HTMLElement | null {
  const anchors = scrollAnchors(container);
  const containerRect = container.getBoundingClientRect();
  return (
    anchors.find((anchor) => {
      const rect = anchor.getBoundingClientRect();
      return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    }) ??
    anchors.at(-1) ??
    null
  );
}

function captureScrollPosition(
  container: HTMLElement,
): ThreadScrollPosition | null {
  const anchor = firstVisibleScrollAnchor(container);
  const targetEventId = anchor?.getAttribute(SCROLL_ANCHOR_ATTRIBUTE);
  if (!anchor || !targetEventId) {
    return null;
  }
  return {
    targetEventId,
    viewportOffsetTop:
      anchor.getBoundingClientRect().top -
      container.getBoundingClientRect().top,
  };
}

function sameScrollPosition(
  left: ThreadScrollPosition | undefined,
  right: ThreadScrollPosition,
): boolean {
  return (
    left?.targetEventId === right.targetEventId &&
    left.viewportOffsetTop === right.viewportOffsetTop
  );
}

interface ScrollRuntime {
  initialized: boolean;
  resizeScheduled: boolean;
}

function createInternalScrollSignals(threadId: string) {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const scrollContainer$ = computed((get) => {
    return get(internalScrollContainer$);
  });
  const threadScrollPosition$ = computed((get) => {
    return get(threadScrollPositions$).get(threadId) ?? null;
  });
  const awayFromBottom$ = computed((get) => {
    return get(threadScrollPosition$) !== null;
  });

  const setThreadScrollPosition$ = command(
    ({ get, set }, position: ThreadScrollPosition) => {
      const positions = get(threadScrollPositions$);
      if (sameScrollPosition(positions.get(threadId), position)) {
        return;
      }
      const next = new Map(positions);
      next.set(threadId, position);
      set(threadScrollPositions$, next);
    },
  );
  const clearThreadScrollPosition$ = command(({ get, set }) => {
    const positions = get(threadScrollPositions$);
    if (!positions.has(threadId)) {
      return;
    }
    const next = new Map(positions);
    next.delete(threadId);
    set(threadScrollPositions$, next);
  });
  const syncThreadScrollPosition$ = command(
    ({ set }, container: HTMLElement) => {
      if (isAtBottom(container)) {
        set(clearThreadScrollPosition$);
        return;
      }
      const position = captureScrollPosition(container);
      if (position) {
        set(setThreadScrollPosition$, position);
      }
    },
  );
  const bindScrollContainer$ = command(
    ({ set }, container: HTMLElement): void => {
      set(internalScrollContainer$, container);
    },
  );
  const clearScrollContainer$ = command(
    ({ get, set }, container: HTMLElement): void => {
      if (get(internalScrollContainer$) === container) {
        set(internalScrollContainer$, null);
      }
    },
  );

  return {
    scrollContainer$,
    threadScrollPosition$,
    awayFromBottom$,
    syncThreadScrollPosition$,
    clearThreadScrollPosition$,
    bindScrollContainer$,
    clearScrollContainer$,
  };
}

type InternalScrollSignals = ReturnType<typeof createInternalScrollSignals>;

function createScrollNavigationSignals(
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
) {
  const scrollTo$ = command(({ get }, position: ThreadScrollPosition) => {
    const container = get(scroll.scrollContainer$);
    if (!container) {
      return false;
    }
    const target = scrollAnchorForEvent(container, position.targetEventId);
    if (!target) {
      return false;
    }
    const currentViewportOffsetTop =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top;
    container.scrollTop +=
      currentViewportOffsetTop - position.viewportOffsetTop;
    runtime.initialized = true;
    return true;
  });

  const scrollToBottom$ = command(({ get, set }) => {
    const container = get(scroll.scrollContainer$);
    if (!container) {
      return;
    }
    set(scroll.clearThreadScrollPosition$);
    container.scrollTop = container.scrollHeight;
    runtime.initialized = true;
  });

  const scrollToTop$ = command(({ get, set }) => {
    const container = get(scroll.scrollContainer$);
    if (!container) {
      return;
    }
    container.scrollTop = 0;
    runtime.initialized = true;
    set(scroll.syncThreadScrollPosition$, container);
  });

  const restoreAfterResize$ = command(({ get, set }) => {
    const position = get(scroll.threadScrollPosition$);
    if (position && set(scrollTo$, position)) {
      return;
    }
    set(scrollToBottom$);
  });

  return { scrollTo$, scrollToBottom$, scrollToTop$, restoreAfterResize$ };
}

type ScrollNavigationSignals = ReturnType<typeof createScrollNavigationSignals>;

function createScrollContainerOnRef(
  scroll: InternalScrollSignals,
  navigation: ScrollNavigationSignals,
  runtime: ScrollRuntime,
) {
  return onRef(
    command(({ set }, container: HTMLElement, signal: AbortSignal) => {
      set(scroll.bindScrollContainer$, container);

      const handleScroll = () => {
        set(scroll.syncThreadScrollPosition$, container);
      };
      const scheduleRestoreAfterResize = () => {
        if (!runtime.initialized || runtime.resizeScheduled) {
          return;
        }
        runtime.resizeScheduled = true;
        animationFrame(
          () => {
            runtime.resizeScheduled = false;
            set(navigation.restoreAfterResize$);
          },
          { signal },
        );
      };
      const resizeObserver = new ResizeObserver(scheduleRestoreAfterResize);

      container.addEventListener("scroll", handleScroll, {
        capture: true,
        passive: true,
      });
      resizeObserver.observe(container);
      container.ownerDocument.defaultView?.visualViewport?.addEventListener(
        "resize",
        scheduleRestoreAfterResize,
        { passive: true },
      );

      signal.addEventListener(
        "abort",
        () => {
          runtime.resizeScheduled = false;
          set(scroll.syncThreadScrollPosition$, container);
          container.removeEventListener("scroll", handleScroll, {
            capture: true,
          });
          resizeObserver.disconnect();
          container.ownerDocument.defaultView?.visualViewport?.removeEventListener(
            "resize",
            scheduleRestoreAfterResize,
          );
          set(scroll.clearScrollContainer$, container);
        },
        { once: true },
      );
    }),
  );
}

export function createChatThreadScrollSignals(
  threadId: string,
): ChatThreadScrollSignals {
  const runtime: ScrollRuntime = {
    initialized: false,
    resizeScheduled: false,
  };
  const scroll = createInternalScrollSignals(threadId);
  const navigation = createScrollNavigationSignals(scroll, runtime);
  const scrollContainerOnRef$ = createScrollContainerOnRef(
    scroll,
    navigation,
    runtime,
  );

  return {
    scrollContainerOnRef$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    awayFromBottom$: scroll.awayFromBottom$,
    scrollTo$: navigation.scrollTo$,
    scrollToTop$: navigation.scrollToTop$,
    scrollToBottom$: navigation.scrollToBottom$,
  };
}
