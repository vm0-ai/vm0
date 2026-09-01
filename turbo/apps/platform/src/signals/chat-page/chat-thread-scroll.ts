import { command, computed, state, type Command, type Computed } from "ccstate";
import { animationFrame } from "signal-timers";
import { logger } from "../log.ts";
import { onDomEventFn, onRef, setLoop } from "../utils.ts";
import type { ChatEvent } from "./chat-event-types.ts";

const L = logger("AutoScroll");
const AT_BOTTOM_THRESHOLD_PX = 10;
const SCROLL_ANCHOR_ATTRIBUTE = "data-chat-scroll-anchor-event-id";
const SCROLL_COMMIT_REVISION_ATTRIBUTE = "data-chat-scroll-commit-revision";
const SCROLL_COMMIT_TO_TAIL_ATTRIBUTE = "data-chat-scroll-commit-to-tail";

export interface ThreadScrollPosition {
  readonly targetEventId: string;
  readonly viewportOffsetTop: number;
}

export interface ScrollToEventOptions {
  readonly behavior: ScrollBehavior;
  readonly viewportOffsetTop: number;
  readonly preloadPreviousRenderWindow: boolean;
}

export interface ScrollAfterRenderRequest {
  readonly revision: number;
  readonly position: ThreadScrollPosition | null;
  readonly behavior: ScrollBehavior;
}

export interface ReadyScrollAfterRenderRequest {
  readonly request: ScrollAfterRenderRequest;
  readonly renderedEventKeys: readonly string[];
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
  readonly scrollCommitOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly pendingScrollAfterRenderRequest$: Computed<ScrollAfterRenderRequest | null>;
  /** The mounted scroll viewport, for readers that measure it themselves. */
  readonly scrollContainer$: Computed<HTMLElement | null>;
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
  readonly scrollToEvent$: Command<
    Promise<void>,
    [string, ScrollToEventOptions, AbortSignal]
  >;
  readonly scrollTo$: Command<void, [ThreadScrollPosition]>;
  readonly scrollToTop$: Command<Promise<void>, [AbortSignal]>;
  readonly scrollToBottom$: Command<Promise<void>, [AbortSignal]>;
}

const threadScrollPositions$ = state(new Map<string, ThreadScrollPosition>());

interface ThreadScrollPositionSignals {
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
}

interface ChatThreadScrollRenderWindow {
  readonly afterThreadScrollPositionChanged$: Command<
    Promise<void>,
    [AbortSignal]
  >;
  readonly preloadPreviousRenderWindowForEvent$: Command<
    Promise<void>,
    [string, AbortSignal]
  >;
}

/**
 * Read-only view of a thread's held scroll position. Derived from module
 * state, so it can be created before the scroll signals themselves — the
 * render window is computed from it, while the commands that write the
 * position are wired to run the window's ensure step afterwards.
 */
export function createThreadScrollPositionSignals(
  threadId: string,
): ThreadScrollPositionSignals {
  const threadScrollPosition$ = computed((get) => {
    return get(threadScrollPositions$).get(threadId) ?? null;
  });
  const awayFromBottom$ = computed((get) => {
    return get(threadScrollPosition$) !== null;
  });
  return { threadScrollPosition$, awayFromBottom$ };
}

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

function scrollContainerForCommitMarker(marker: HTMLElement): HTMLElement {
  const container = marker.closest("[data-scroll-container]");
  if (!(container instanceof HTMLElement)) {
    throw new Error("Chat scroll commit marker has no scroll container");
  }
  return container;
}

function scrollRenderRevision(marker: HTMLElement): number {
  const value = marker.getAttribute(SCROLL_COMMIT_REVISION_ATTRIBUTE);
  const revision = Number(value);
  if (value === null || revision < 1 || !Number.isSafeInteger(revision)) {
    throw new Error("Chat scroll commit marker has no valid revision");
  }
  return revision;
}

function applyScrollTop(
  runtime: ScrollRuntime,
  container: HTMLElement,
  scrollTop: number,
  behavior: ScrollBehavior = "instant",
): void {
  if (behavior === "smooth") {
    const targetScrollTop = Math.max(
      0,
      Math.min(scrollTop, container.scrollHeight - container.clientHeight),
    );
    if (runtime.programmaticSmoothScrollTop === targetScrollTop) {
      return;
    }
    runtime.programmaticScrollTop = null;
    runtime.programmaticSmoothScrollTop = targetScrollTop;
    container.scrollTo({ top: targetScrollTop, behavior });
    return;
  }
  runtime.programmaticSmoothScrollTop = null;
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
  behavior: ScrollBehavior = "instant",
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
    behavior,
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
  // Smooth scrolling spans several browser scroll events. Keep its target so
  // those events do not rewrite the held event position, and so a resize
  // restore during the animation preserves the requested behavior.
  programmaticSmoothScrollTop: number | null;
}

function createInternalScrollSignals(
  threadId: string,
  position: ThreadScrollPositionSignals,
  afterThreadScrollPositionChanged$: Command<Promise<void>, [AbortSignal]>,
) {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const scrollContainer$ = computed((get) => {
    return get(internalScrollContainer$);
  });
  const { threadScrollPosition$, awayFromBottom$ } = position;

  // The held position feeds the render window, so every write below runs the
  // window's ensure step afterwards — parsing is command-driven, and this is
  // one of the places the set of visible events can change.
  const setThreadScrollPosition$ = command(
    async (
      { get, set },
      position: ThreadScrollPosition,
      signal: AbortSignal,
    ): Promise<void> => {
      const positions = get(threadScrollPositions$);
      if (sameScrollPosition(positions.get(threadId), position)) {
        return;
      }
      const next = new Map(positions);
      next.set(threadId, position);
      set(threadScrollPositions$, next);
      await set(afterThreadScrollPositionChanged$, signal);
    },
  );
  const clearThreadScrollPosition$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const positions = get(threadScrollPositions$);
      if (!positions.has(threadId)) {
        return;
      }
      const next = new Map(positions);
      next.delete(threadId);
      set(threadScrollPositions$, next);
      await set(afterThreadScrollPositionChanged$, signal);
    },
  );
  const syncThreadScrollPosition$ = command(
    async (
      { set },
      container: HTMLElement,
      capturePosition: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      if (isAtBottom(container)) {
        L.debug("scroll position cleared at bottom", {
          threadId,
          scrollTop: container.scrollTop,
        });
        await set(clearThreadScrollPosition$, signal);
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
        L.debug("scroll position captured", {
          threadId,
          ...position,
          scrollTop: container.scrollTop,
        });
        await set(setThreadScrollPosition$, position, signal);
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
    setThreadScrollPosition$,
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
  pendingScrollAfterRenderRequest$: Computed<ScrollAfterRenderRequest | null>,
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

  const scrollToBottom$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const container = get(scroll.scrollContainer$);
      if (!container) {
        throw new Error("Chat scroll container is not mounted");
      }
      L.debug("scroll to bottom", {
        threadId,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        heldTargetEventId:
          get(scroll.threadScrollPosition$)?.targetEventId ?? null,
      });
      // The DOM write happens before the awaited state clear so the jump is
      // part of the current task and cannot paint at the old offset first.
      applyScrollTop(runtime, container, container.scrollHeight);
      runtime.initialized = true;
      await set(scroll.clearThreadScrollPosition$, signal);
    },
  );

  const scrollToTop$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const container = get(scroll.scrollContainer$);
      if (!container) {
        throw new Error("Chat scroll container is not mounted");
      }
      applyScrollTop(runtime, container, 0);
      runtime.initialized = true;
      await set(scroll.syncThreadScrollPosition$, container, true, signal);
    },
  );

  const restoreAfterResize$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
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
      if (position) {
        if (
          scrollToPosition(
            runtime,
            container,
            position,
            runtime.programmaticSmoothScrollTop === null ? "instant" : "smooth",
          )
        ) {
          runtime.initialized = true;
          return;
        }
        if (get(pendingScrollAfterRenderRequest$) !== null) {
          // Event rendering can replace the content between ResizeObserver's
          // notification and this restore. The commit marker owns that pending
          // batch, so keep the anchor until React acknowledges its final DOM.
          L.debug("resize scroll restore waiting for render commit", {
            threadId,
            targetEventId: position.targetEventId,
          });
          return;
        }
        L.debug("resize scroll restore target no longer rendered", {
          threadId,
          targetEventId: position.targetEventId,
        });
      }
      await set(scrollToBottom$, signal);
    },
  );

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
        onDomEventFn(() => {
          runtime.resizeScheduled = false;
          return set(restoreAfterResize$, signal);
        }),
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
  const restoreAfterContentResize$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      if (!runtime.initialized) {
        return;
      }
      L.debug("content resize scroll restore", { threadId });
      await set(restoreAfterResize$, signal);
    },
  );

  return {
    scrollTo$,
    scrollToBottom$,
    scrollToTop$,
    scheduleRestoreAfterResize$,
    restoreAfterContentResize$,
  };
}

/** Commits scroll only when React acknowledges the matching event batch. */
function createRenderScrollSignals(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
) {
  const internalPendingRequest$ = state<ScrollAfterRenderRequest | null>(null);
  const pendingScrollAfterRenderRequest$ = computed((get) => {
    return get(internalPendingRequest$);
  });
  const clearPendingRequest$ = command(
    ({ get, set }, revision: number): void => {
      if (get(internalPendingRequest$)?.revision === revision) {
        set(internalPendingRequest$, null);
      }
    },
  );
  const scrollCommitOnRef$ = onRef(
    command(
      async (
        { get, set },
        marker: HTMLElement,
        signal: AbortSignal,
      ): Promise<void> => {
        signal.throwIfAborted();
        const revision = scrollRenderRevision(marker);
        const request = get(pendingScrollAfterRenderRequest$);
        if (!request || request.revision !== revision) {
          L.debug("stale render scroll commit ignored", {
            threadId,
            revision,
            currentRevision: request?.revision ?? null,
          });
          return;
        }
        const container = scrollContainerForCommitMarker(marker);
        if (scrollAnchors(container).length === 0) {
          L.debug("render scroll commit waiting for messages", {
            threadId,
            revision,
          });
          return;
        }
        const commitToTail = marker.hasAttribute(
          SCROLL_COMMIT_TO_TAIL_ATTRIBUTE,
        );
        if (commitToTail) {
          applyScrollTop(
            runtime,
            container,
            container.scrollHeight,
            request.behavior,
          );
        } else if (
          !request.position ||
          !scrollToPosition(
            runtime,
            container,
            request.position,
            request.behavior,
          )
        ) {
          throw new Error(
            `Chat scroll target is not rendered: ${request.position?.targetEventId ?? "none"}`,
          );
        }
        runtime.initialized = true;
        set(clearPendingRequest$, revision);
        L.debug("render scroll committed", {
          threadId,
          revision,
          targetEventId: request.position?.targetEventId ?? null,
          viewportOffsetTop: request.position?.viewportOffsetTop ?? null,
          behavior: request.behavior,
          scrollTop: container.scrollTop,
        });
        if (commitToTail) {
          // After the DOM write: the commit runs during React's ref phase, and
          // the offset must be applied before this frame paints.
          await set(scroll.clearThreadScrollPosition$, signal);
        }
      },
    ),
  );
  const requestScrollAfterRender$ = command(
    async (
      { set },
      position: ThreadScrollPosition | null,
      behavior: ScrollBehavior,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      runtime.latestRenderRequestRevision += 1;
      const request: ScrollAfterRenderRequest = {
        revision: runtime.latestRenderRequestRevision,
        position,
        behavior,
      };
      L.debug("render scroll requested", {
        threadId,
        revision: request.revision,
        targetEventId: position?.targetEventId ?? null,
        viewportOffsetTop: position?.viewportOffsetTop ?? null,
        behavior,
      });
      set(internalPendingRequest$, request);
      if (position === null) {
        await set(scroll.clearThreadScrollPosition$, signal);
      }
    },
  );
  const autoScroll$ = command(
    (
      { set },
      position: ThreadScrollPosition | null,
      signal: AbortSignal,
    ): Promise<void> => {
      return set(requestScrollAfterRender$, position, "instant", signal);
    },
  );

  return {
    autoScroll$,
    requestScrollAfterRender$,
    pendingScrollAfterRenderRequest$,
    scrollCommitOnRef$,
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

      const handleScroll = onDomEventFn((event: Event) => {
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
        const smoothScrollTarget = runtime.programmaticSmoothScrollTop;
        const programmatic =
          smoothScrollTarget !== null ||
          runtime.programmaticScrollTop === container.scrollTop;
        if (!programmatic) {
          // The container has left the offset this module wrote, so the reader
          // moved it. Until that happens the offset is still ours no matter how
          // many events describe it, and content growing every frame delivers
          // more of them than the restores that wrote them.
          runtime.programmaticScrollTop = null;
        }
        return set(
          scroll.syncThreadScrollPosition$,
          container,
          !programmatic,
          signal,
        );
      });
      const scheduleRestoreAfterResize = () => {
        set(navigation.scheduleRestoreAfterResize$, signal);
      };
      const handleScrollEnd = (event: Event) => {
        if (
          event.target === container &&
          runtime.programmaticSmoothScrollTop !== null
        ) {
          // A fractional target can produce one near-terminal integer scroll
          // offset before the browser reports its final rounded offset. Keep
          // the whole animation programmatic until scrollend, then carry the
          // actual terminal offset into the ordinary duplicate-event guard.
          runtime.programmaticScrollTop = container.scrollTop;
          runtime.programmaticSmoothScrollTop = null;
        }
      };
      const resizeObserver = new ResizeObserver(scheduleRestoreAfterResize);

      container.addEventListener("scroll", handleScroll, {
        capture: true,
        passive: true,
      });
      container.addEventListener("scrollend", handleScrollEnd, {
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
          container.removeEventListener("scrollend", handleScrollEnd);
          resizeObserver.disconnect();
          container.ownerDocument.defaultView?.visualViewport?.removeEventListener(
            "resize",
            scheduleRestoreAfterResize,
          );
          set(scroll.clearScrollContainer$, container);
          runtime.initialized = false;
          runtime.programmaticScrollTop = null;
          runtime.programmaticSmoothScrollTop = null;
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
      const resizeObserver = new ResizeObserver(
        onDomEventFn(() => {
          return set(navigation.restoreAfterContentResize$, signal);
        }),
      );
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
  position: ThreadScrollPositionSignals,
  renderWindow: ChatThreadScrollRenderWindow,
  chatEvents$: Computed<readonly ChatEvent[]>,
  initialEventsReady$: Computed<boolean>,
): ChatThreadScrollSignals {
  const runtime: ScrollRuntime = {
    initialized: false,
    resizeScheduled: false,
    latestRenderRequestRevision: 0,
    programmaticScrollTop: null,
    programmaticSmoothScrollTop: null,
  };
  const scroll = createInternalScrollSignals(
    threadId,
    position,
    renderWindow.afterThreadScrollPositionChanged$,
  );
  const render = createRenderScrollSignals(threadId, scroll, runtime);
  const navigation = createScrollNavigationSignals(
    threadId,
    scroll,
    runtime,
    render.pendingScrollAfterRenderRequest$,
  );
  const scrollContainerOnRef$ = createScrollContainerOnRef(
    threadId,
    scroll,
    navigation,
    runtime,
  );
  const scrollContentOnRef$ = createScrollContentOnRef(threadId, navigation);
  const scrollToEvent$ = command(
    async (
      { get, set },
      eventId: string,
      options: ScrollToEventOptions,
      signal: AbortSignal,
    ): Promise<void> => {
      await setLoop(
        () => {
          return get(initialEventsReady$);
        },
        16,
        signal,
        { retryTransientErrors: false },
      );
      signal.throwIfAborted();
      const eventExists = get(chatEvents$).some((event) => {
        return event.id === eventId;
      });
      if (!eventExists) {
        L.debug("scroll target event not found", { threadId, eventId });
        return;
      }
      if (options.preloadPreviousRenderWindow) {
        await set(
          renderWindow.preloadPreviousRenderWindowForEvent$,
          eventId,
          signal,
        );
        signal.throwIfAborted();
      }
      const position: ThreadScrollPosition = {
        targetEventId: eventId,
        viewportOffsetTop: options.viewportOffsetTop,
      };
      await set(scroll.setThreadScrollPosition$, position, signal);
      signal.throwIfAborted();
      await set(
        render.requestScrollAfterRender$,
        position,
        options.behavior,
        signal,
      );
    },
  );

  return {
    scrollContainerOnRef$,
    scrollContentOnRef$,
    scrollCommitOnRef$: render.scrollCommitOnRef$,
    pendingScrollAfterRenderRequest$: render.pendingScrollAfterRenderRequest$,
    scrollContainer$: scroll.scrollContainer$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    awayFromBottom$: scroll.awayFromBottom$,
    readRenderedThreadScrollPosition$: scroll.readRenderedThreadScrollPosition$,
    autoScroll$: render.autoScroll$,
    scrollToEvent$,
    scrollTo$: navigation.scrollTo$,
    scrollToTop$: navigation.scrollToTop$,
    scrollToBottom$: navigation.scrollToBottom$,
  };
}
