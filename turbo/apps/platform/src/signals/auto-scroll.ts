import { command, state } from "ccstate";
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
 * persisted in a module-level cache. On the first `scrollToBottom$` call
 * after a new container binds with the same id, the saved position is
 * restored instead — this preserves reading position across chat-thread
 * switches. The cache is cleared once the user scrolls back to the bottom.
 */
export function createScrollSignals(id?: string) {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const autoScrollDisabled$ = state(false);
  let firstScrollToBottomCall = true;
  // Held while ResizeObserver is still growing the container up to a saved
  // position — set scrollTop clamps early and needs to be re-applied.
  let pendingRestorePosition: number | null = null;

  const setScrollContainer$ = onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      set(internalScrollContainer$, el);
      L.debug("container bound");

      let lastKnownScrollTop = el.scrollTop;
      let lastUserInputAt = 0;

      const markUserInput = () => {
        lastUserInputAt = performance.now();
      };

      const onKeyDown = (e: KeyboardEvent) => {
        if (isUserScrollKey(e.key)) {
          markUserInput();
        }
      };

      const onScroll = () => {
        const distanceFromBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight;
        const userRecent =
          performance.now() - lastUserInputAt < USER_INPUT_WINDOW_MS;
        if (pendingRestorePosition !== null && userRecent) {
          pendingRestorePosition = null;
        }
        if (distanceFromBottom <= AT_BOTTOM_THRESHOLD) {
          const wasDisabled = get(autoScrollDisabled$);
          set(autoScrollDisabled$, false);
          if (id !== undefined) {
            set(clearCachedScrollTop$, id);
          }
          if (wasDisabled) {
            L.debug("re-enabled (at bottom)", scrollInfo(el));
          }
        } else if (el.scrollTop < lastKnownScrollTop) {
          // Only treat a scrollTop decrease as "user scrolled up" when it
          // coincides with a recent user input. The browser can also decrease
          // scrollTop on its own — when content below the viewport shrinks it
          // clamps to the new max, and scroll anchoring can nudge position on
          // layout changes. Those programmatic shifts should not disable
          // auto-scroll; we want ResizeObserver to snap back to the bottom.
          if (userRecent) {
            const wasDisabled = get(autoScrollDisabled$);
            set(autoScrollDisabled$, true);
            if (!wasDisabled) {
              L.debug("DISABLED (scrolled up)", scrollInfo(el));
            }
          } else {
            L.debug("scrollTop decreased without user input", scrollInfo(el));
          }
        }
        if (id !== undefined && get(autoScrollDisabled$)) {
          set(setCachedScrollTop$, id, el.scrollTop);
        }
        lastKnownScrollTop = el.scrollTop;
      };

      el.addEventListener("scroll", onScroll, { passive: true });
      el.addEventListener("wheel", markUserInput, { passive: true });
      el.addEventListener("touchmove", markUserInput, { passive: true });
      el.addEventListener("pointerdown", markUserInput, { passive: true });
      el.addEventListener("keydown", onKeyDown, { passive: true });

      const resizeObserver = new ResizeObserver(() => {
        const disabled = get(autoScrollDisabled$);
        L.debug("ResizeObserver fired", scrollInfo(el), `disabled=${disabled}`);
        if (pendingRestorePosition !== null) {
          el.scrollTop = pendingRestorePosition;
          if (el.scrollTop >= pendingRestorePosition) {
            pendingRestorePosition = null;
          }
          return;
        }
        if (!disabled) {
          el.scrollTop = el.scrollHeight;
        }
      });
      const inner = el.firstElementChild;
      if (inner) {
        resizeObserver.observe(inner);
      } else {
        resizeObserver.observe(el);
      }

      signal.addEventListener("abort", () => {
        L.debug("container unbound (abort)");
        resizeObserver.disconnect();
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("wheel", markUserInput);
        el.removeEventListener("touchmove", markUserInput);
        el.removeEventListener("pointerdown", markUserInput);
        el.removeEventListener("keydown", onKeyDown);
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

  const scrollToBottom$ = command(({ get, set }) => {
    const scrollEl = get(internalScrollContainer$);
    if (!scrollEl) {
      L.debug("scrollToBottom$ SKIPPED (no container)");
      return;
    }
    const wasFirst = firstScrollToBottomCall;
    firstScrollToBottomCall = false;
    if (wasFirst && id !== undefined) {
      const saved = get(scrollPositionCache$).get(id);
      if (saved !== undefined) {
        pendingRestorePosition = saved;
        scrollEl.scrollTop = saved;
        set(autoScrollDisabled$, true);
        L.debug("scrollToBottom$ → restored", `id=${id}`, `saved=${saved}`);
        return;
      }
    }
    L.debug("scrollToBottom$ → scrolling to bottom", scrollInfo(scrollEl));
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  return { setScrollContainer$, autoScroll$, scrollToBottom$ };
}
