import { command, state, type Command } from "ccstate";
import { onRef } from "./utils.ts";
import { logger } from "./log.ts";

const L = logger("AutoScroll");
const AT_BOTTOM_THRESHOLD = 10;
const USER_INPUT_WINDOW_MS = 200;

// Persists a user's last non-bottom scroll position across container
// re-binds (e.g. when switching between parallel chat threads). Keyed by
// caller-provided id — typically a threadId. When absent, no caching occurs.
const scrollPositionCache$ = state(new Map<string, number>());

const setCachedScrollTop$ = command(
  ({ get, set }, id: string, scrollTop: number) => {
    const cache = get(scrollPositionCache$);
    if (cache.get(id) === scrollTop) {
      return;
    }
    const next = new Map(cache);
    next.set(id, scrollTop);
    set(scrollPositionCache$, next);
  },
);

const clearCachedScrollTop$ = command(({ get, set }, id: string) => {
  const cache = get(scrollPositionCache$);
  if (!cache.has(id)) {
    return;
  }
  const next = new Map(cache);
  next.delete(id);
  set(scrollPositionCache$, next);
});

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

function scrollInfo(el: HTMLElement) {
  const top = Math.round(el.scrollTop);
  const height = el.scrollHeight;
  const client = el.clientHeight;
  const fromBottom = height - top - client;
  return `scrollTop=${top} scrollHeight=${height} clientHeight=${client} fromBottom=${fromBottom}`;
}

interface RestoreState {
  pendingRestorePosition: number | null;
  suppressNextScrollToBottom: boolean;
  // Snapshot taken just before prepending older messages. The ResizeObserver
  // detects the resulting height increase and adds the delta to scrollTop so
  // the user's viewport stays anchored on the same content.
  pendingPrependScrollHeight: number | null;
}

function attachUserInputListeners(
  el: HTMLElement,
  markUserInput: () => void,
  onScroll: () => void,
  signal: AbortSignal,
) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (isUserScrollKey(e.key)) {
      markUserInput();
    }
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("wheel", markUserInput, { passive: true });
  el.addEventListener("touchmove", markUserInput, { passive: true });
  el.addEventListener("pointerdown", markUserInput, { passive: true });
  el.addEventListener("keydown", onKeyDown, { passive: true });
  signal.addEventListener("abort", () => {
    el.removeEventListener("scroll", onScroll);
    el.removeEventListener("wheel", markUserInput);
    el.removeEventListener("touchmove", markUserInput);
    el.removeEventListener("pointerdown", markUserInput);
    el.removeEventListener("keydown", onKeyDown);
  });
}

function observeContainerResize(
  el: HTMLElement,
  onResize: () => void,
  signal: AbortSignal,
) {
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(el.firstElementChild ?? el);
  signal.addEventListener("abort", () => {
    resizeObserver.disconnect();
  });
}

interface ScrollHandlerContext {
  el: HTMLElement;
  restoreState: RestoreState;
  id: string | undefined;
  lastUserInputAt: { v: number };
  lastKnownScrollTop: { v: number };
  isDisabled: () => boolean;
  setDisabled: (v: boolean) => void;
  clearCache: () => void;
  saveCache: (top: number) => void;
}

function buildScrollHandler(ctx: ScrollHandlerContext) {
  return () => {
    const { el, restoreState, lastUserInputAt, lastKnownScrollTop } = ctx;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const userRecent =
      performance.now() - lastUserInputAt.v < USER_INPUT_WINDOW_MS;
    if (restoreState.pendingRestorePosition !== null && userRecent) {
      restoreState.pendingRestorePosition = null;
    }
    if (distanceFromBottom <= AT_BOTTOM_THRESHOLD) {
      const wasDisabled = ctx.isDisabled();
      ctx.setDisabled(false);
      ctx.clearCache();
      if (wasDisabled) {
        L.debug("re-enabled (at bottom)", scrollInfo(el));
      }
    } else if (el.scrollTop < lastKnownScrollTop.v) {
      // Only treat a scrollTop decrease as "user scrolled up" when it
      // coincides with a recent user input. The browser can also decrease
      // scrollTop on its own — when content below the viewport shrinks it
      // clamps to the new max, and scroll anchoring can nudge position on
      // layout changes. Those programmatic shifts should not disable
      // auto-scroll; we want ResizeObserver to snap back to the bottom.
      if (userRecent) {
        const wasDisabled = ctx.isDisabled();
        ctx.setDisabled(true);
        if (!wasDisabled) {
          L.debug("DISABLED (scrolled up)", scrollInfo(el));
        }
      } else {
        L.debug("scrollTop decreased without user input", scrollInfo(el));
      }
    }
    if (ctx.id !== undefined && ctx.isDisabled()) {
      ctx.saveCache(el.scrollTop);
    }
    lastKnownScrollTop.v = el.scrollTop;
  };
}

interface ResizeHandlerContext {
  el: HTMLElement;
  restoreState: RestoreState;
  isDisabled: () => boolean;
}

function buildResizeHandler(ctx: ResizeHandlerContext) {
  return () => {
    const { el, restoreState } = ctx;
    const disabled = ctx.isDisabled();
    L.debug("ResizeObserver fired", scrollInfo(el), `disabled=${disabled}`);
    if (restoreState.pendingRestorePosition !== null) {
      el.scrollTop = restoreState.pendingRestorePosition;
      if (el.scrollTop >= restoreState.pendingRestorePosition) {
        restoreState.pendingRestorePosition = null;
      }
      return;
    }
    if (restoreState.pendingPrependScrollHeight !== null) {
      const delta = el.scrollHeight - restoreState.pendingPrependScrollHeight;
      restoreState.pendingPrependScrollHeight = null;
      if (delta > 0) {
        el.scrollTop += delta;
        L.debug(
          "prepend compensation applied",
          `delta=${delta}`,
          scrollInfo(el),
        );
      }
      return;
    }
    if (!disabled) {
      el.scrollTop = el.scrollHeight;
    }
  };
}

/**
 * Factory that creates scroll-management signals for a scrollable container.
 *
 * Bind `setScrollContainer$` to a `ref`. The factory installs a passive
 * `scroll` listener that tracks whether auto-scroll should be active:
 *
 * - **Disabled** when the user manually scrolls up (scrollTop decreases).
 * - **Re-enabled** when scrolled to the bottom by any means.
 *
 * `autoScroll$`     — scroll to bottom only when auto-scroll is enabled.
 * `scrollToBottom$`  — unconditional force scroll (ignores disabled state).
 *
 * When `id` is provided, the user's last non-bottom scroll position is
 * persisted in a module-level cache. At container-bind time, if the cache
 * holds a saved position for this id, auto-scroll is disabled and the
 * position is queued for restore — this preserves reading position across
 * chat-thread switches. Restore must happen at bind (not on the first
 * `scrollToBottom$` call) because ResizeObserver fires as soon as messages
 * render and would otherwise auto-scroll to bottom first, triggering the
 * "user reached bottom" path that clears the cache before the caller gets
 * a chance to invoke `scrollToBottom$`. The cache is cleared once the user
 * scrolls back to the bottom.
 */
export type RecordScrollHeightForPrepend$ = Command<void, []>;

export function createScrollSignals(id?: string) {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const autoScrollDisabled$ = state(false);
  const restoreState: RestoreState = {
    pendingRestorePosition: null,
    suppressNextScrollToBottom: false,
    pendingPrependScrollHeight: null,
  };

  const setScrollContainer$ = onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      set(internalScrollContainer$, el);
      L.debug("container bound");

      const saved =
        id !== undefined ? get(scrollPositionCache$).get(id) : undefined;
      if (saved !== undefined) {
        restoreState.pendingRestorePosition = saved;
        restoreState.suppressNextScrollToBottom = true;
        el.scrollTop = saved;
        set(autoScrollDisabled$, true);
        L.debug("container bound → restoring", `id=${id}`, `saved=${saved}`);
      }

      const lastKnownScrollTop = { v: el.scrollTop };
      const lastUserInputAt = { v: 0 };

      const markUserInput = () => {
        lastUserInputAt.v = performance.now();
        restoreState.suppressNextScrollToBottom = false;
      };

      const ctx: ScrollHandlerContext = {
        el,
        restoreState,
        id,
        lastUserInputAt,
        lastKnownScrollTop,
        isDisabled: () => {
          return get(autoScrollDisabled$);
        },
        setDisabled: (v) => {
          set(autoScrollDisabled$, v);
        },
        clearCache: () => {
          if (id !== undefined) {
            set(clearCachedScrollTop$, id);
          }
        },
        saveCache: (top) => {
          if (id !== undefined) {
            set(setCachedScrollTop$, id, top);
          }
        },
      };

      const onScroll = buildScrollHandler(ctx);
      const onResize = buildResizeHandler({
        el,
        restoreState,
        isDisabled: ctx.isDisabled,
      });

      attachUserInputListeners(el, markUserInput, onScroll, signal);
      observeContainerResize(el, onResize, signal);

      signal.addEventListener("abort", () => {
        L.debug("container unbound (abort)");
        set(internalScrollContainer$, null);
      });
    }),
  );

  const autoScroll$ = command(({ get }) => {
    const disabled = get(autoScrollDisabled$);
    if (disabled) {
      L.debug("autoScroll$ SKIPPED (disabled)");
      return;
    }
    const scrollEl = get(internalScrollContainer$);
    if (!scrollEl) {
      L.debug("autoScroll$ SKIPPED (no container)");
      return;
    }
    L.debug("autoScroll$ → scrolling to bottom", scrollInfo(scrollEl));
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  const scrollToBottom$ = command(({ get }) => {
    const scrollEl = get(internalScrollContainer$);
    if (!scrollEl) {
      return;
    }
    if (restoreState.suppressNextScrollToBottom) {
      restoreState.suppressNextScrollToBottom = false;
      return;
    }
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  // Snapshot the container's current scrollHeight before prepending messages.
  // The ResizeObserver callback will detect the resulting height increase and
  // compensate scrollTop so the viewport stays anchored on the same content.
  const recordScrollHeightForPrepend$ = command(({ get }) => {
    const el = get(internalScrollContainer$);
    if (el) {
      restoreState.pendingPrependScrollHeight = el.scrollHeight;
      L.debug("recordScrollHeightForPrepend$", `height=${el.scrollHeight}`);
    }
  });

  // Scrolling to top is an explicit opt-out of auto-scroll — disable it so
  // ResizeObserver doesn't snap back to the bottom when new messages arrive.
  const scrollToTop$ = command(({ get, set }) => {
    const scrollEl = get(internalScrollContainer$);
    if (!scrollEl) {
      return;
    }
    set(autoScrollDisabled$, true);
    restoreState.suppressNextScrollToBottom = false;
    if (id !== undefined) {
      set(setCachedScrollTop$, id, 0);
    }
    scrollEl.scrollTop = 0;
  });

  return {
    setScrollContainer$,
    autoScroll$,
    scrollToBottom$,
    scrollToTop$,
    recordScrollHeightForPrepend$,
  };
}
