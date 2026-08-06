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

export interface ChatThreadScrollSignals {
  readonly scrollContainerOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly scrollContentOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
  readonly readRenderedThreadScrollPosition$: Command<
    ThreadScrollPosition | null,
    []
  >;
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
  // Selected by attribute rather than scanned out of `scrollAnchors`: a reader
  // holding an anchor restores on every frame the thread grows, and collecting
  // every anchor in the thread first would walk the whole history before each
  // paint.
  return container.querySelector<HTMLElement>(
    `[${SCROLL_ANCHOR_ATTRIBUTE}="${eventId}"]`,
  );
}

function applyScrollTop(
  runtime: ScrollRuntime,
  container: HTMLElement,
  scrollTop: number,
): void {
  container.scrollTop = scrollTop;
  // Remember where this module left the container. The browser clamps the
  // assignment, so read the offset back instead of trusting the requested one.
  runtime.programmaticScrollTop = container.scrollTop;
}

/** Returns false when the anchored event is not in the DOM. */
function scrollToPosition(
  runtime: ScrollRuntime,
  container: HTMLElement,
  position: ThreadScrollPosition,
): boolean {
  const target = scrollAnchorForEvent(container, position.targetEventId);
  if (!target) {
    return false;
  }
  const currentViewportOffsetTop =
    target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  applyScrollTop(
    runtime,
    container,
    container.scrollTop + currentViewportOffsetTop - position.viewportOffsetTop,
  );
  return true;
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
  // Offset this module last wrote to the container, cleared once the container
  // reports a different one. Scroll events are delivered asynchronously, so
  // content rendered in between (an async diagram, a late image) can make that
  // event measure as "not at the bottom" and park the thread on an anchor
  // nobody chose.
  programmaticScrollTop: number | null;
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
    ({ set }, container: HTMLElement, capturePosition: boolean) => {
      if (isAtBottom(container)) {
        set(clearThreadScrollPosition$);
        L.debug("scroll position cleared at bottom", {
          threadId,
          scrollTop: container.scrollTop,
        });
        return;
      }
      if (!capturePosition) {
        L.debug("programmatic scroll position ignored", {
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
  const readRenderedThreadScrollPosition$ = command(({ get }) => {
    const currentPosition = get(threadScrollPosition$);
    if (currentPosition === null) {
      return null;
    }
    const container = get(scrollContainer$);
    if (!container) {
      return currentPosition;
    }
    if (isAtBottom(container)) {
      return null;
    }
    return captureScrollPosition(container) ?? currentPosition;
  });
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
    readRenderedThreadScrollPosition$,
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
    if (!scrollToPosition(runtime, container, position)) {
      throw new Error(
        `Chat scroll target is not rendered: ${position.targetEventId}`,
      );
    }
    runtime.initialized = true;
  });

  const scrollToBottom$ = command(({ get, set }) => {
    const container = get(scroll.scrollContainer$);
    if (!container) {
      throw new Error("Chat scroll container is not mounted");
    }
    set(scroll.clearThreadScrollPosition$);
    applyScrollTop(runtime, container, container.scrollHeight);
    runtime.initialized = true;
  });

  const scrollToTop$ = command(({ get, set }) => {
    const container = get(scroll.scrollContainer$);
    if (!container) {
      throw new Error("Chat scroll container is not mounted");
    }
    applyScrollTop(runtime, container, 0);
    runtime.initialized = true;
    set(scroll.syncThreadScrollPosition$, container, true);
  });

  const restoreAfterResize$ = command(({ get, set }) => {
    const position = get(scroll.threadScrollPosition$);
    const container = get(scroll.scrollContainer$);
    L.debug("resize scroll restore", {
      threadId,
      targetEventId: position?.targetEventId ?? null,
      viewportOffsetTop: position?.viewportOffsetTop ?? null,
    });
    if (!container) {
      throw new Error("Chat scroll container is not mounted");
    }
    if (position && scrollToPosition(runtime, container, position)) {
      runtime.initialized = true;
      return;
    }
    // Either the thread is following the tail, or the event it anchors to has
    // left the DOM — a queued message moves into the thinking indicator, which
    // renders no anchor. Holding a position nothing renders would freeze the
    // thread where it stands and every later resize would try again, so the
    // thread goes back to following the tail.
    set(scrollToBottom$);
  });

  // The viewport and the composer settle their layout over a frame, so their
  // restore waits for the next one and the flag folds repeated notifications
  // into a single run. Resizing the viewport also reflows the message box, so
  // the content observer restores inside the frame as well and this pass then
  // runs once more against the settled layout; both write the same position,
  // which makes the repeat invisible.
  const scheduleRestoreAfterResize$ = command(
    ({ set }, signal: AbortSignal) => {
      if (!runtime.initialized || runtime.resizeScheduled) {
        return;
      }
      runtime.resizeScheduled = true;
      L.debug("resize scroll restore scheduled", { threadId });
      animationFrame(
        () => {
          runtime.resizeScheduled = false;
          set(restoreAfterResize$);
        },
        { signal },
      );
    },
  );

  // Content growth restores in the same frame that produced it. ResizeObserver
  // callbacks run after layout and before paint, so a scroll written here is
  // part of that frame; waiting for the next one would paint the grown content
  // at the old offset first, which reads as a flash before the view snaps back.
  // Deliberately outside `resizeScheduled`: sharing that flag would fold this
  // restore into the deferred pass, which is the frame of delay it exists to
  // avoid.
  const restoreAfterContentResize$ = command(({ set }) => {
    if (!runtime.initialized) {
      return;
    }
    L.debug("content resize scroll restore", { threadId });
    set(restoreAfterResize$);
  });

  return {
    scrollTo$,
    scrollToBottom$,
    scrollToTop$,
    scheduleRestoreAfterResize$,
    restoreAfterContentResize$,
  };
}

/**
 * Commits the scroll that belongs to a rendered batch of events: one frame
 * after the events change, either back to the bottom or onto the anchor the
 * reader is holding.
 */
function createRenderScrollSignals(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
) {
  const commitScrollAfterRender$ = command(
    ({ get, set }, request: ScrollAfterRenderRequest): void => {
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
      if (
        !request.position ||
        !scrollToPosition(runtime, container, request.position)
      ) {
        // The batch either follows the tail, or it carries a position whose
        // event this render does not show: sending while a run is active
        // queues the message, and a queued message moves into the thinking
        // indicator, which renders no anchor. Nothing can hold that position,
        // so the thread follows the tail rather than staying put.
        set(scroll.clearThreadScrollPosition$);
        applyScrollTop(runtime, container, container.scrollHeight);
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

  return { autoScroll$ };
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

      const handleScroll = (event: Event) => {
        if (!runtime.initialized) {
          L.debug("pre-initialization scroll ignored", { threadId });
          return;
        }
        if (event.target !== container) {
          // The listener runs in the capture phase, so nested scrollers (wide
          // diagrams, code blocks, tables) deliver their scroll events here
          // too. Where they sit says nothing about where the thread sits.
          return;
        }
        const programmatic =
          runtime.programmaticScrollTop === container.scrollTop;
        if (!programmatic) {
          // The container has left the offset this module wrote, so the reader
          // moved it. Until that happens the offset is still ours no matter how
          // many events describe it, and content growing every frame delivers
          // more of them than the restores that wrote them.
          runtime.programmaticScrollTop = null;
        }
        set(scroll.syncThreadScrollPosition$, container, !programmatic);
      };
      const scheduleRestoreAfterResize = () => {
        set(navigation.scheduleRestoreAfterResize$, signal);
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
          runtime.programmaticScrollTop = null;
          L.debug("container unbound", { threadId });
        },
        { once: true },
      );
    }),
  );
}

/**
 * Observes the element that holds the messages. The container's own box only
 * changes with the viewport or the composer, so content that arrives after its
 * scroll was committed — a diagram that finishes rendering, an image that
 * finishes loading — is invisible to the container observer and leaves the
 * thread stranded above the bottom.
 *
 * `observe` delivers once on its own. Both refs belong to the same thread and
 * bind together, so that delivery either arrives before the thread is
 * initialized and is dropped, or arrives in the frame the render commit already
 * scrolled and re-applies the position the thread is holding.
 */
function createScrollContentOnRef(
  threadId: string,
  navigation: ScrollNavigationSignals,
) {
  return onRef(
    command(({ set }, content: HTMLElement, signal: AbortSignal) => {
      L.debug("content bound", { threadId });
      const resizeObserver = new ResizeObserver(() => {
        set(navigation.restoreAfterContentResize$);
      });
      resizeObserver.observe(content);
      signal.addEventListener(
        "abort",
        () => {
          resizeObserver.disconnect();
          L.debug("content unbound", { threadId });
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
    programmaticScrollTop: null,
  };
  const scroll = createInternalScrollSignals(threadId);
  const navigation = createScrollNavigationSignals(threadId, scroll, runtime);
  const render = createRenderScrollSignals(threadId, scroll, runtime);
  const scrollContainerOnRef$ = createScrollContainerOnRef(
    threadId,
    scroll,
    navigation,
    runtime,
  );
  const scrollContentOnRef$ = createScrollContentOnRef(threadId, navigation);

  return {
    scrollContainerOnRef$,
    scrollContentOnRef$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    awayFromBottom$: scroll.awayFromBottom$,
    readRenderedThreadScrollPosition$: scroll.readRenderedThreadScrollPosition$,
    autoScroll$: render.autoScroll$,
    scrollTo$: navigation.scrollTo$,
    scrollToTop$: navigation.scrollToTop$,
    scrollToBottom$: navigation.scrollToBottom$,
  };
}
