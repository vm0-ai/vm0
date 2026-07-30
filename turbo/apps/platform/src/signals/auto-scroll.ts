import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef } from "./utils.ts";
import { logger } from "./log.ts";

const L = logger("AutoScroll");
const AT_BOTTOM_THRESHOLD = 10;
const USER_INPUT_WINDOW_MS = 200;
const KEY_SCROLL_STEP_PX = 72;
const COARSE_POINTER_QUERY = "(pointer: coarse)";

export type ScrollStepDirection = "up" | "down";
export type PrependScrollCompensationToken = symbol;

interface PendingPrependScrollRecord {
  readonly token: PrependScrollCompensationToken;
  scrollHeight: number;
  scrollTop: number;
}

interface ScrollSignalOptions {
  observeViewportResizeOnMobile?: boolean;
}

interface ScrollSignals {
  setScrollContainer$: Command<(() => void) | undefined, [HTMLElement | null]>;
  autoScroll$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
  scrollToTop$: Command<void, []>;
  scrollBy$: Command<boolean, [ScrollStepDirection]>;
  prepareKeyboardScroll$: Command<boolean, []>;
  recordScrollHeightForPrepend$: Command<
    PrependScrollCompensationToken | null,
    []
  >;
  clearScrollHeightForPrepend$: Command<
    void,
    [PrependScrollCompensationToken | null | undefined]
  >;
  awayFromBottom$: Computed<boolean>;
}

// Persists a user's last non-bottom scroll position across container
// re-binds (e.g. when switching between parallel chat threads). Keyed by
// caller-provided id — typically a threadId. When the id is absent (callers
// that opt out of caching), both commands are no-ops.
const scrollPositionCache$ = state(new Map<string, number>());

const setCachedScrollTop$ = command(
  ({ get, set }, id: string | undefined, scrollTop: number) => {
    if (id === undefined) {
      return;
    }
    const cache = get(scrollPositionCache$);
    if (cache.get(id) === scrollTop) {
      return;
    }
    const next = new Map(cache);
    next.set(id, scrollTop);
    set(scrollPositionCache$, next);
  },
);

const clearCachedScrollTop$ = command(
  ({ get, set }, id: string | undefined) => {
    if (id === undefined) {
      return;
    }
    const cache = get(scrollPositionCache$);
    if (!cache.has(id)) {
      return;
    }
    const next = new Map(cache);
    next.delete(id);
    set(scrollPositionCache$, next);
  },
);

function isUserScrollKey(key: string): boolean {
  return (
    key === "PageUp" ||
    key === "PageDown" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End" ||
    key === " "
  );
}

function clampScrollTop(el: HTMLElement, scrollTop: number): number {
  const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  return Math.max(0, Math.min(scrollTop, maxScrollTop));
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isAtBottom(el: HTMLElement): boolean {
  return distanceFromBottom(el) <= AT_BOTTOM_THRESHOLD;
}

function scrollToBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

function scrollInfo(el: HTMLElement) {
  const top = Math.round(el.scrollTop);
  const height = el.scrollHeight;
  const client = el.clientHeight;
  return `scrollTop=${top} scrollHeight=${height} clientHeight=${client} fromBottom=${distanceFromBottom(el)}`;
}

function attachUserInputListeners(
  el: HTMLElement,
  markInput: () => void,
  onScroll: () => void,
  signal: AbortSignal,
) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (isUserScrollKey(e.key)) {
      markInput();
    }
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("wheel", markInput, { passive: true });
  el.addEventListener("touchmove", markInput, { passive: true });
  el.addEventListener("pointerdown", markInput, { passive: true });
  el.addEventListener("keydown", onKeyDown, { passive: true });
  signal.addEventListener("abort", () => {
    el.removeEventListener("scroll", onScroll);
    el.removeEventListener("wheel", markInput);
    el.removeEventListener("touchmove", markInput);
    el.removeEventListener("pointerdown", markInput);
    el.removeEventListener("keydown", onKeyDown);
  });
}

function observeContainerResize(
  el: HTMLElement,
  onResize: () => void,
  signal: AbortSignal,
  observeViewportResizeOnMobile: boolean,
) {
  const resizeObserver = new ResizeObserver(onResize);
  const content = el.firstElementChild ?? el;
  resizeObserver.observe(content);
  const win = el.ownerDocument.defaultView;
  if (
    observeViewportResizeOnMobile &&
    content !== el &&
    win?.matchMedia(COARSE_POINTER_QUERY).matches === true
  ) {
    resizeObserver.observe(el);
  }
  signal.addEventListener("abort", () => {
    resizeObserver.disconnect();
  });
}

type ScrollRuntime = {
  lastKnownScrollTop: number;
  lastUserInputAt: number;
  pendingRestorePosition: number | null;
  suppressNextScrollToBottom: boolean;
  suppressNextResizeScrollToBottom: boolean;
  pendingPrependScrollRecords: PendingPrependScrollRecord[];
};

function createScrollRuntime(): ScrollRuntime {
  return {
    lastKnownScrollTop: 0,
    lastUserInputAt: 0,
    pendingRestorePosition: null,
    suppressNextScrollToBottom: false,
    suppressNextResizeScrollToBottom: false,
    pendingPrependScrollRecords: [],
  };
}

function markUserInput(runtime: ScrollRuntime): void {
  runtime.lastUserInputAt = performance.now();
  runtime.suppressNextScrollToBottom = false;
}

function hasRecentUserInput(runtime: ScrollRuntime): boolean {
  return performance.now() - runtime.lastUserInputAt < USER_INPUT_WINDOW_MS;
}

function createInternalScrollSignals() {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const internalAutoScrollDisabled$ = state(false);
  const internalAwayFromBottom$ = state(false);
  const scrollContainer$ = computed((get) => {
    return get(internalScrollContainer$);
  });
  const autoScrollDisabled$ = computed((get) => {
    return get(internalAutoScrollDisabled$);
  });
  const awayFromBottom$ = computed((get) => {
    return get(internalAwayFromBottom$);
  });
  const bindScrollContainer$ = command(({ set }, el: HTMLElement) => {
    set(internalScrollContainer$, el);
  });
  const clearScrollContainer$ = command(({ set }) => {
    set(internalScrollContainer$, null);
  });
  const setAutoScrollDisabled$ = command(({ set }, disabled: boolean) => {
    set(internalAutoScrollDisabled$, disabled);
  });
  const syncAwayFromBottom$ = command(
    ({ get, set }, awayFromBottom: boolean) => {
      if (get(internalAwayFromBottom$) !== awayFromBottom) {
        set(internalAwayFromBottom$, awayFromBottom);
      }
    },
  );

  return {
    scrollContainer$,
    autoScrollDisabled$,
    awayFromBottom$,
    bindScrollContainer$,
    clearScrollContainer$,
    setAutoScrollDisabled$,
    syncAwayFromBottom$,
  };
}

type InternalScrollSignals = ReturnType<typeof createInternalScrollSignals>;

function createHandleScrollCommand(
  id: string | undefined,
  runtime: ScrollRuntime,
  scroll: InternalScrollSignals,
) {
  return command(({ get, set }, el: HTMLElement) => {
    const atBottom = isAtBottom(el);
    // Drives the floating scroll-to-bottom button. Recomputed on every scroll
    // event (including the programmatic scrolls that fire when content grows or
    // a scroll command runs) so the button reflects the live viewport position.
    set(scroll.syncAwayFromBottom$, !atBottom);
    const userRecent = hasRecentUserInput(runtime);
    if (runtime.pendingRestorePosition !== null && userRecent) {
      runtime.pendingRestorePosition = null;
    }
    if (atBottom) {
      runtime.suppressNextResizeScrollToBottom = false;
      if (get(scroll.autoScrollDisabled$)) {
        L.debug("re-enabled (at bottom)", scrollInfo(el));
      }
      set(scroll.setAutoScrollDisabled$, false);
      set(clearCachedScrollTop$, id);
    } else if (el.scrollTop < runtime.lastKnownScrollTop) {
      // Only treat a scrollTop decrease as "user scrolled up" when it
      // coincides with a recent user input. The browser can also decrease
      // scrollTop on its own — when content below the viewport shrinks it
      // clamps to the new max, and scroll anchoring can nudge position on
      // layout changes. Those programmatic shifts should not disable
      // auto-scroll; we want ResizeObserver to snap back to the bottom.
      if (userRecent) {
        if (!get(scroll.autoScrollDisabled$)) {
          L.debug("DISABLED (scrolled up)", scrollInfo(el));
        }
        set(scroll.setAutoScrollDisabled$, true);
      } else {
        L.debug("scrollTop decreased without user input", scrollInfo(el));
      }
    }
    if (get(scroll.autoScrollDisabled$)) {
      set(setCachedScrollTop$, id, el.scrollTop);
    }
    runtime.lastKnownScrollTop = el.scrollTop;
  });
}

function createHandleResizeCommand(
  id: string | undefined,
  runtime: ScrollRuntime,
  scroll: InternalScrollSignals,
) {
  return command(({ get, set }, el: HTMLElement) => {
    const disabled = get(scroll.autoScrollDisabled$);
    L.debug("ResizeObserver fired", scrollInfo(el), `disabled=${disabled}`);
    if (runtime.pendingRestorePosition !== null) {
      const target = runtime.pendingRestorePosition;
      el.scrollTop = target;
      if (el.scrollTop >= target) {
        runtime.pendingRestorePosition = null;
      }
      return;
    }
    const prependRecord = runtime.pendingPrependScrollRecords.shift();
    if (prependRecord) {
      const delta = el.scrollHeight - prependRecord.scrollHeight;
      if (delta > 0) {
        el.scrollTop = prependRecord.scrollTop + delta;
        const awayFromBottom = !isAtBottom(el);
        set(scroll.syncAwayFromBottom$, awayFromBottom);
        if (awayFromBottom) {
          runtime.suppressNextResizeScrollToBottom = true;
          set(scroll.setAutoScrollDisabled$, true);
          set(setCachedScrollTop$, id, el.scrollTop);
        }
        runtime.lastKnownScrollTop = el.scrollTop;
        L.debug(
          "prepend compensation applied",
          `delta=${delta}`,
          scrollInfo(el),
        );
      }
      for (const pendingRecord of runtime.pendingPrependScrollRecords) {
        pendingRecord.scrollHeight = el.scrollHeight;
        pendingRecord.scrollTop = el.scrollTop;
      }
      return;
    }
    if (runtime.suppressNextResizeScrollToBottom) {
      runtime.suppressNextResizeScrollToBottom = false;
      L.debug("resize scroll-to-bottom suppressed after prepend");
      return;
    }
    if (!disabled) {
      scrollToBottom(el);
    }
  });
}

type ScrollHandlers = {
  handleScroll$: Command<void, [HTMLElement]>;
  handleResize$: Command<void, [HTMLElement]>;
};

function createSetScrollContainerCommand({
  id,
  observeViewportResizeOnMobile,
  runtime,
  scroll,
  handlers,
}: {
  id: string | undefined;
  observeViewportResizeOnMobile: boolean;
  runtime: ScrollRuntime;
  scroll: InternalScrollSignals;
  handlers: ScrollHandlers;
}) {
  return onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      set(scroll.bindScrollContainer$, el);
      L.debug("container bound");

      const saved =
        id === undefined ? undefined : get(scrollPositionCache$).get(id);
      if (saved !== undefined) {
        runtime.pendingRestorePosition = saved;
        runtime.suppressNextScrollToBottom = true;
        el.scrollTop = saved;
        set(scroll.setAutoScrollDisabled$, true);
        // A cached position is always non-bottom — reflect it immediately.
        set(scroll.syncAwayFromBottom$, true);
        L.debug("container bound → restoring", `id=${id}`, `saved=${saved}`);
      }

      runtime.lastKnownScrollTop = el.scrollTop;
      runtime.lastUserInputAt = 0;

      attachUserInputListeners(
        el,
        () => {
          markUserInput(runtime);
        },
        () => {
          set(handlers.handleScroll$, el);
        },
        signal,
      );
      observeContainerResize(
        el,
        () => {
          set(handlers.handleResize$, el);
        },
        signal,
        observeViewportResizeOnMobile,
      );

      signal.addEventListener("abort", () => {
        L.debug("container unbound (abort)");
        set(scroll.clearScrollContainer$);
      });
    }),
  );
}

function createScrollNavigationSignals(
  id: string | undefined,
  runtime: ScrollRuntime,
  scroll: InternalScrollSignals,
) {
  const autoScroll$ = command(({ get }) => {
    if (get(scroll.autoScrollDisabled$)) {
      L.debug("autoScroll$ SKIPPED (disabled)");
      return;
    }
    const el = get(scroll.scrollContainer$);
    if (!el) {
      L.debug("autoScroll$ SKIPPED (no container)");
      return;
    }
    L.debug("autoScroll$ → scrolling to bottom", scrollInfo(el));
    scrollToBottom(el);
  });

  const scrollToBottom$ = command(({ get }) => {
    const el = get(scroll.scrollContainer$);
    if (!el) {
      return;
    }
    if (runtime.suppressNextScrollToBottom) {
      runtime.suppressNextScrollToBottom = false;
      return;
    }
    runtime.suppressNextResizeScrollToBottom = false;
    scrollToBottom(el);
  });

  const scrollToTop$ = command(({ get, set }) => {
    const el = get(scroll.scrollContainer$);
    if (!el) {
      return;
    }
    set(scroll.setAutoScrollDisabled$, true);
    runtime.suppressNextScrollToBottom = false;
    set(setCachedScrollTop$, id, 0);
    el.scrollTop = 0;
  });

  const scrollBy$ = command(({ get, set }, direction: ScrollStepDirection) => {
    const el = get(scroll.scrollContainer$);
    if (!el) {
      return false;
    }
    const delta = direction === "up" ? -KEY_SCROLL_STEP_PX : KEY_SCROLL_STEP_PX;
    const nextScrollTop = clampScrollTop(el, el.scrollTop + delta);
    if (nextScrollTop === el.scrollTop) {
      return false;
    }

    markUserInput(runtime);
    el.scrollTop = nextScrollTop;

    if (isAtBottom(el)) {
      set(scroll.setAutoScrollDisabled$, false);
      set(clearCachedScrollTop$, id);
    } else if (direction === "up") {
      set(scroll.setAutoScrollDisabled$, true);
      set(setCachedScrollTop$, id, el.scrollTop);
    } else if (get(scroll.autoScrollDisabled$)) {
      set(setCachedScrollTop$, id, el.scrollTop);
    }
    runtime.lastKnownScrollTop = el.scrollTop;
    return true;
  });

  const prepareKeyboardScroll$ = command(({ get }) => {
    const el = get(scroll.scrollContainer$);
    if (!el) {
      return false;
    }
    markUserInput(runtime);
    if (!el.contains(el.ownerDocument.activeElement)) {
      el.focus({ preventScroll: true });
    }
    return true;
  });

  return {
    autoScroll$,
    scrollToBottom$,
    scrollToTop$,
    scrollBy$,
    prepareKeyboardScroll$,
  };
}

function createPrependScrollSignals(
  runtime: ScrollRuntime,
  scroll: InternalScrollSignals,
) {
  const recordScrollHeightForPrepend$ = command(({ get }) => {
    const el = get(scroll.scrollContainer$);
    if (!el) {
      return null;
    }
    const token: PrependScrollCompensationToken = Symbol(
      "prepend-scroll-compensation",
    );
    runtime.pendingPrependScrollRecords.push({
      token,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    });
    runtime.lastKnownScrollTop = el.scrollTop;
    L.debug("recordScrollHeightForPrepend$", `height=${el.scrollHeight}`);
    return token;
  });

  const clearScrollHeightForPrepend$ = command(
    (_, token: PrependScrollCompensationToken | null | undefined) => {
      if (!token) {
        return;
      }
      const index = runtime.pendingPrependScrollRecords.findIndex((record) => {
        return record.token === token;
      });
      if (index !== -1) {
        runtime.pendingPrependScrollRecords.splice(index, 1);
      }
    },
  );

  return {
    recordScrollHeightForPrepend$,
    clearScrollHeightForPrepend$,
  };
}

/**
 * Factory that creates scroll-management signals for a scrollable container.
 *
 * Bind `setScrollContainer$` to a `ref`. The returned object exposes only
 * computed values and commands; its writable states remain private to the
 * internal signal factory.
 */
export function createScrollSignals(
  id?: string,
  options: ScrollSignalOptions = {},
): ScrollSignals {
  const runtime = createScrollRuntime();
  const scroll = createInternalScrollSignals();
  const handlers = {
    handleScroll$: createHandleScrollCommand(id, runtime, scroll),
    handleResize$: createHandleResizeCommand(id, runtime, scroll),
  };

  return {
    setScrollContainer$: createSetScrollContainerCommand({
      id,
      observeViewportResizeOnMobile:
        options.observeViewportResizeOnMobile === true,
      runtime,
      scroll,
      handlers,
    }),
    ...createScrollNavigationSignals(id, runtime, scroll),
    ...createPrependScrollSignals(runtime, scroll),
    awayFromBottom$: scroll.awayFromBottom$,
  };
}
