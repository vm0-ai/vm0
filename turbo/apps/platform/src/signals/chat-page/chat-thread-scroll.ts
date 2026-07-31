import { command, computed, state, type Command, type Computed } from "ccstate";
import { animationFrame } from "signal-timers";
import { logger } from "../log.ts";
import { onRef } from "../utils.ts";

const L = logger("AutoScroll");
const AT_BOTTOM_THRESHOLD_PX = 10;
const SCROLL_ANCHOR_ATTRIBUTE = "data-chat-scroll-anchor-event-id";

export interface ThreadScrollPosition {
  readonly targetEventId: string;
  readonly viewportOffsetTop: number;
}

interface ScrollAfterRenderRequest {
  readonly revision: number;
  readonly position: ThreadScrollPosition | null;
}

interface ChatThreadScrollSignals {
  readonly scrollContainerOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
  readonly autoScroll$: Command<
    Promise<void>,
    [ThreadScrollPosition | null, AbortSignal]
  >;
  readonly scrollTo$: Command<void, [ThreadScrollPosition]>;
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

function scrollToPosition(
  container: HTMLElement,
  position: ThreadScrollPosition,
): void {
  const target = scrollAnchorForEvent(container, position.targetEventId);
  if (!target) {
    throw new Error(
      `Chat scroll target is not rendered: ${position.targetEventId}`,
    );
  }
  const currentViewportOffsetTop =
    target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += currentViewportOffsetTop - position.viewportOffsetTop;
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
  latestRenderRequestRevision: number;
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
        L.debug("scroll position cleared at bottom", {
          threadId,
          scrollTop: container.scrollTop,
        });
        return;
      }
      const position = captureScrollPosition(container);
      if (position) {
        set(setThreadScrollPosition$, position);
        L.debug("scroll position captured", {
          threadId,
          ...position,
          scrollTop: container.scrollTop,
        });
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
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
) {
  const scrollTo$ = command(({ get }, position: ThreadScrollPosition) => {
    const container = get(scroll.scrollContainer$);
    if (!container) {
      throw new Error("Chat scroll container is not mounted");
    }
    scrollToPosition(container, position);
    runtime.initialized = true;
  });

  const scrollToBottom$ = command(({ get, set }) => {
    const container = get(scroll.scrollContainer$);
    if (!container) {
      throw new Error("Chat scroll container is not mounted");
    }
    set(scroll.clearThreadScrollPosition$);
    container.scrollTop = container.scrollHeight;
    runtime.initialized = true;
  });

  const scrollToTop$ = command(({ get, set }) => {
    const container = get(scroll.scrollContainer$);
    if (!container) {
      throw new Error("Chat scroll container is not mounted");
    }
    container.scrollTop = 0;
    runtime.initialized = true;
    set(scroll.syncThreadScrollPosition$, container);
  });

  const restoreAfterResize$ = command(({ get, set }) => {
    const position = get(scroll.threadScrollPosition$);
    L.debug("resize scroll restore", {
      threadId,
      targetEventId: position?.targetEventId ?? null,
      viewportOffsetTop: position?.viewportOffsetTop ?? null,
    });
    if (position) {
      set(scrollTo$, position);
      return;
    }
    set(scrollToBottom$);
  });

  const commitScrollAfterRender$ = command(
    ({ get }, request: ScrollAfterRenderRequest): void => {
      if (request.revision !== runtime.latestRenderRequestRevision) {
        L.debug("stale render scroll ignored", {
          revision: request.revision,
          currentRevision: runtime.latestRenderRequestRevision,
        });
        return;
      }
      const container = get(scroll.scrollContainer$);
      if (!container) {
        L.debug("render scroll skipped without container", {
          threadId,
          revision: request.revision,
        });
        return;
      }
      if (scrollAnchors(container).length === 0) {
        L.debug("render scroll skipped without messages", {
          threadId,
          revision: request.revision,
        });
        return;
      }
      if (request.position) {
        scrollToPosition(container, request.position);
      } else {
        container.scrollTop = container.scrollHeight;
      }
      runtime.initialized = true;
      L.debug("render scroll committed", {
        threadId,
        revision: request.revision,
        targetEventId: request.position?.targetEventId ?? null,
        viewportOffsetTop: request.position?.viewportOffsetTop ?? null,
        scrollTop: container.scrollTop,
      });
    },
  );
  const autoScroll$ = command(
    (
      { set },
      position: ThreadScrollPosition | null,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (position === null) {
        set(scroll.clearThreadScrollPosition$);
      }
      runtime.latestRenderRequestRevision += 1;
      const request: ScrollAfterRenderRequest = {
        revision: runtime.latestRenderRequestRevision,
        position,
      };
      L.debug("render scroll requested", {
        threadId,
        revision: request.revision,
        targetEventId: position?.targetEventId ?? null,
        viewportOffsetTop: position?.viewportOffsetTop ?? null,
      });
      animationFrame(
        () => {
          set(commitScrollAfterRender$, request);
        },
        { signal },
      );
      return Promise.resolve();
    },
  );

  return {
    scrollTo$,
    scrollToBottom$,
    scrollToTop$,
    restoreAfterResize$,
    autoScroll$,
  };
}

type ScrollNavigationSignals = ReturnType<typeof createScrollNavigationSignals>;

function createScrollContainerOnRef(
  threadId: string,
  scroll: InternalScrollSignals,
  navigation: ScrollNavigationSignals,
  runtime: ScrollRuntime,
) {
  return onRef(
    command(({ set }, container: HTMLElement, signal: AbortSignal) => {
      set(scroll.bindScrollContainer$, container);
      L.debug("container bound", {
        threadId,
        initialized: runtime.initialized,
      });

      const handleScroll = () => {
        if (!runtime.initialized) {
          L.debug("pre-initialization scroll ignored", { threadId });
          return;
        }
        set(scroll.syncThreadScrollPosition$, container);
      };
      const scheduleRestoreAfterResize = () => {
        if (!runtime.initialized || runtime.resizeScheduled) {
          return;
        }
        runtime.resizeScheduled = true;
        L.debug("resize scroll restore scheduled", { threadId });
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
          container.removeEventListener("scroll", handleScroll, {
            capture: true,
          });
          resizeObserver.disconnect();
          container.ownerDocument.defaultView?.visualViewport?.removeEventListener(
            "resize",
            scheduleRestoreAfterResize,
          );
          set(scroll.clearScrollContainer$, container);
          runtime.initialized = false;
          L.debug("container unbound", { threadId });
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
    latestRenderRequestRevision: 0,
  };
  const scroll = createInternalScrollSignals(threadId);
  const navigation = createScrollNavigationSignals(threadId, scroll, runtime);
  const scrollContainerOnRef$ = createScrollContainerOnRef(
    threadId,
    scroll,
    navigation,
    runtime,
  );

  return {
    scrollContainerOnRef$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    awayFromBottom$: scroll.awayFromBottom$,
    autoScroll$: navigation.autoScroll$,
    scrollTo$: navigation.scrollTo$,
    scrollToTop$: navigation.scrollToTop$,
    scrollToBottom$: navigation.scrollToBottom$,
  };
}
