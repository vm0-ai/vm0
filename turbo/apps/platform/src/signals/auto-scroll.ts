import { command, computed, state, type Command, type State } from "ccstate";
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

/**
 * Everything one bound scroll container needs, created once per
 * `createScrollSignals` call and shared by every command in this file.
 *
 * Three intents compete for the container's `scrollTop`, and each one owns
 * fields here:
 *
 * - **restore** a cached reading position: `pendingRestorePosition`,
 *   `suppressNextScrollToBottom`
 * - **compensate** a prepend of older messages: `pendingPrependScrollRecords`,
 *   `suppressNextResizeScrollToBottom`
 * - **follow the bottom**: `disabled$` (false means "keep following")
 *
 * `handleResize$` is the single arbiter and resolves them in that order.
 */
interface ScrollContext {
  /** Cache key for the reading position; caching is off when undefined. */
  readonly id: string | undefined;
  readonly observeViewportResizeOnMobile: boolean;
  readonly container$: State<HTMLElement | null>;
  /** True once the user gave up following the bottom. */
  readonly disabled$: State<boolean>;
  /**
   * Distance-from-bottom flag for UI (the scroll-to-bottom button), unlike
   * `disabled$` which carries the follow-the-bottom intent.
   */
  readonly awayFromBottomState$: State<boolean>;
  /** Writes `awayFromBottomState$` only on change to avoid re-renders. */
  readonly syncAwayFromBottom$: Command<void, [boolean]>;
  /** Previous `scrollTop`, used to detect upward scrolling. */
  lastKnownScrollTop: number;
  /** `performance.now()` of the last user scroll input. */
  lastUserInputAt: number;
  pendingRestorePosition: number | null;
  suppressNextScrollToBottom: boolean;
  suppressNextResizeScrollToBottom: boolean;
  // Snapshots taken just before prepending older messages. Each async caller
  // owns a token so a no-op clear from one path cannot discard another path's
  // pending compensation.
  pendingPrependScrollRecords: PendingPrependScrollRecord[];
}

function createScrollContext(
  id: string | undefined,
  options: ScrollSignalOptions,
): ScrollContext {
  const awayFromBottomState$ = state(false);
  return {
    id,
    observeViewportResizeOnMobile:
      options.observeViewportResizeOnMobile === true,
    container$: state<HTMLElement | null>(null),
    disabled$: state(false),
    awayFromBottomState$,
    syncAwayFromBottom$: command(({ get, set }, awayFromBottom: boolean) => {
      if (get(awayFromBottomState$) !== awayFromBottom) {
        set(awayFromBottomState$, awayFromBottom);
      }
    }),
    lastKnownScrollTop: 0,
    lastUserInputAt: 0,
    pendingRestorePosition: null,
    suppressNextScrollToBottom: false,
    suppressNextResizeScrollToBottom: false,
    pendingPrependScrollRecords: [],
  };
}

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

function markUserInput(ctx: ScrollContext): void {
  ctx.lastUserInputAt = performance.now();
  ctx.suppressNextScrollToBottom = false;
}

function hasRecentUserInput(ctx: ScrollContext): boolean {
  return performance.now() - ctx.lastUserInputAt < USER_INPUT_WINDOW_MS;
}

/**
 * Re-applies a cached reading position until the rendered content is tall
 * enough to hold it. Returns true while the restore still owns `scrollTop`.
 */
function applyPendingRestore(ctx: ScrollContext, el: HTMLElement): boolean {
  const target = ctx.pendingRestorePosition;
  if (target === null) {
    return false;
  }
  el.scrollTop = target;
  if (el.scrollTop >= target) {
    ctx.pendingRestorePosition = null;
  }
  return true;
}

/**
 * Later prepends snapshotted the pre-compensation layout, so rebase them onto
 * the layout this compensation just produced.
 */
function rebasePendingPrependRecords(
  ctx: ScrollContext,
  el: HTMLElement,
): void {
  for (const pendingRecord of ctx.pendingPrependScrollRecords) {
    pendingRecord.scrollHeight = el.scrollHeight;
    pendingRecord.scrollTop = el.scrollTop;
  }
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

/**
 * Tracks the follow-the-bottom intent from `scroll` events: reaching the bottom
 * resumes following it, scrolling up during a user gesture gives it up.
 */
function createHandleScrollCommand(ctx: ScrollContext) {
  return command(({ get, set }, el: HTMLElement) => {
    const atBottom = isAtBottom(el);
    // Drives the floating scroll-to-bottom button. Recomputed on every scroll
    // event (including the programmatic scrolls that fire when content grows or
    // a scroll command runs) so the button reflects the live viewport position.
    set(ctx.syncAwayFromBottom$, !atBottom);
    const userRecent = hasRecentUserInput(ctx);
    if (ctx.pendingRestorePosition !== null && userRecent) {
      ctx.pendingRestorePosition = null;
    }
    if (atBottom) {
      ctx.suppressNextResizeScrollToBottom = false;
      if (get(ctx.disabled$)) {
        L.debug("re-enabled (at bottom)", scrollInfo(el));
      }
      set(ctx.disabled$, false);
      set(clearCachedScrollTop$, ctx.id);
    } else if (el.scrollTop < ctx.lastKnownScrollTop) {
      // Only treat a scrollTop decrease as "user scrolled up" when it
      // coincides with a recent user input. The browser can also decrease
      // scrollTop on its own — when content below the viewport shrinks it
      // clamps to the new max, and scroll anchoring can nudge position on
      // layout changes. Those programmatic shifts should not disable
      // auto-scroll; we want ResizeObserver to snap back to the bottom.
      if (userRecent) {
        if (!get(ctx.disabled$)) {
          L.debug("DISABLED (scrolled up)", scrollInfo(el));
        }
        set(ctx.disabled$, true);
      } else {
        L.debug("scrollTop decreased without user input", scrollInfo(el));
      }
    }
    if (get(ctx.disabled$)) {
      set(setCachedScrollTop$, ctx.id, el.scrollTop);
    }
    ctx.lastKnownScrollTop = el.scrollTop;
  });
}

/**
 * The single arbiter for content-height changes: restore wins over prepend
 * compensation, which wins over following the bottom.
 */
function createHandleResizeCommand(ctx: ScrollContext) {
  return command(({ get, set }, el: HTMLElement) => {
    const disabled = get(ctx.disabled$);
    L.debug("ResizeObserver fired", scrollInfo(el), `disabled=${disabled}`);
    if (applyPendingRestore(ctx, el)) {
      return;
    }
    const prependRecord = ctx.pendingPrependScrollRecords.shift();
    if (prependRecord) {
      const delta = el.scrollHeight - prependRecord.scrollHeight;
      if (delta > 0) {
        el.scrollTop = prependRecord.scrollTop + delta;
        const awayFromBottom = !isAtBottom(el);
        set(ctx.syncAwayFromBottom$, awayFromBottom);
        if (awayFromBottom) {
          ctx.suppressNextResizeScrollToBottom = true;
          set(ctx.disabled$, true);
          set(setCachedScrollTop$, ctx.id, el.scrollTop);
        }
        ctx.lastKnownScrollTop = el.scrollTop;
        L.debug(
          "prepend compensation applied",
          `delta=${delta}`,
          scrollInfo(el),
        );
      }
      rebasePendingPrependRecords(ctx, el);
      return;
    }
    if (ctx.suppressNextResizeScrollToBottom) {
      ctx.suppressNextResizeScrollToBottom = false;
      L.debug("resize scroll-to-bottom suppressed after prepend");
      return;
    }
    if (!disabled) {
      scrollToBottom(el);
    }
  });
}

function createAutoScrollCommand(ctx: ScrollContext) {
  return command(({ get }) => {
    if (get(ctx.disabled$)) {
      L.debug("autoScroll$ SKIPPED (disabled)");
      return;
    }
    const el = get(ctx.container$);
    if (!el) {
      L.debug("autoScroll$ SKIPPED (no container)");
      return;
    }
    L.debug("autoScroll$ → scrolling to bottom", scrollInfo(el));
    scrollToBottom(el);
  });
}

function createScrollToBottomCommand(ctx: ScrollContext) {
  return command(({ get }) => {
    const el = get(ctx.container$);
    if (!el) {
      return;
    }
    if (ctx.suppressNextScrollToBottom) {
      ctx.suppressNextScrollToBottom = false;
      return;
    }
    ctx.suppressNextResizeScrollToBottom = false;
    scrollToBottom(el);
  });
}

function createScrollToTopCommand(ctx: ScrollContext) {
  return command(({ get, set }) => {
    const el = get(ctx.container$);
    if (!el) {
      return;
    }
    set(ctx.disabled$, true);
    ctx.suppressNextScrollToBottom = false;
    set(setCachedScrollTop$, ctx.id, 0);
    el.scrollTop = 0;
  });
}

function createScrollByCommand(ctx: ScrollContext) {
  return command(({ get, set }, direction: ScrollStepDirection) => {
    const el = get(ctx.container$);
    if (!el) {
      return false;
    }
    const delta = direction === "up" ? -KEY_SCROLL_STEP_PX : KEY_SCROLL_STEP_PX;
    const nextScrollTop = clampScrollTop(el, el.scrollTop + delta);
    if (nextScrollTop === el.scrollTop) {
      return false;
    }

    markUserInput(ctx);
    el.scrollTop = nextScrollTop;

    if (isAtBottom(el)) {
      set(ctx.disabled$, false);
      set(clearCachedScrollTop$, ctx.id);
    } else if (direction === "up") {
      set(ctx.disabled$, true);
      set(setCachedScrollTop$, ctx.id, el.scrollTop);
    } else if (get(ctx.disabled$)) {
      set(setCachedScrollTop$, ctx.id, el.scrollTop);
    }
    ctx.lastKnownScrollTop = el.scrollTop;
    return true;
  });
}

function createPrepareKeyboardScrollCommand(ctx: ScrollContext) {
  return command(({ get }) => {
    const el = get(ctx.container$);
    if (!el) {
      return false;
    }
    markUserInput(ctx);
    if (!el.contains(el.ownerDocument.activeElement)) {
      el.focus({ preventScroll: true });
    }
    return true;
  });
}

function createRecordScrollHeightForPrependCommand(ctx: ScrollContext) {
  return command(({ get }) => {
    const el = get(ctx.container$);
    if (!el) {
      return null;
    }
    const token: PrependScrollCompensationToken = Symbol(
      "prepend-scroll-compensation",
    );
    ctx.pendingPrependScrollRecords.push({
      token,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    });
    ctx.lastKnownScrollTop = el.scrollTop;
    L.debug("recordScrollHeightForPrepend$", `height=${el.scrollHeight}`);
    return token;
  });
}

function createClearScrollHeightForPrependCommand(ctx: ScrollContext) {
  return command(
    (_ctx, token: PrependScrollCompensationToken | null | undefined) => {
      if (!token) {
        return;
      }
      const index = ctx.pendingPrependScrollRecords.findIndex((record) => {
        return record.token === token;
      });
      if (index !== -1) {
        ctx.pendingPrependScrollRecords.splice(index, 1);
      }
    },
  );
}

function createSetScrollContainerCommand(
  ctx: ScrollContext,
  handleScroll$: Command<void, [HTMLElement]>,
  handleResize$: Command<void, [HTMLElement]>,
) {
  return onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      set(ctx.container$, el);
      L.debug("container bound");

      const saved =
        ctx.id === undefined
          ? undefined
          : get(scrollPositionCache$).get(ctx.id);
      if (saved !== undefined) {
        ctx.pendingRestorePosition = saved;
        ctx.suppressNextScrollToBottom = true;
        el.scrollTop = saved;
        set(ctx.disabled$, true);
        // A cached position is always non-bottom — reflect it immediately.
        set(ctx.awayFromBottomState$, true);
        L.debug(
          "container bound → restoring",
          `id=${ctx.id}`,
          `saved=${saved}`,
        );
      }

      ctx.lastKnownScrollTop = el.scrollTop;
      ctx.lastUserInputAt = 0;

      attachUserInputListeners(
        el,
        () => {
          markUserInput(ctx);
        },
        () => {
          set(handleScroll$, el);
        },
        signal,
      );
      observeContainerResize(
        el,
        () => {
          set(handleResize$, el);
        },
        signal,
        ctx.observeViewportResizeOnMobile,
      );

      signal.addEventListener("abort", () => {
        L.debug("container unbound (abort)");
        set(ctx.container$, null);
      });
    }),
  );
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
export function createScrollSignals(
  id?: string,
  options: ScrollSignalOptions = {},
) {
  const ctx = createScrollContext(id, options);
  const handleScroll$ = createHandleScrollCommand(ctx);
  const handleResize$ = createHandleResizeCommand(ctx);

  return {
    setScrollContainer$: createSetScrollContainerCommand(
      ctx,
      handleScroll$,
      handleResize$,
    ),
    autoScroll$: createAutoScrollCommand(ctx),
    scrollToBottom$: createScrollToBottomCommand(ctx),
    scrollToTop$: createScrollToTopCommand(ctx),
    scrollBy$: createScrollByCommand(ctx),
    prepareKeyboardScroll$: createPrepareKeyboardScrollCommand(ctx),
    recordScrollHeightForPrepend$:
      createRecordScrollHeightForPrependCommand(ctx),
    clearScrollHeightForPrepend$: createClearScrollHeightForPrependCommand(ctx),
    awayFromBottom$: computed((get) => {
      return get(ctx.awayFromBottomState$);
    }),
  };
}
