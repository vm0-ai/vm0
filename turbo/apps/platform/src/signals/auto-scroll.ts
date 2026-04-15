import { command, state } from "ccstate";
import { onRef } from "./utils.ts";

const AT_BOTTOM_THRESHOLD = 10;

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
 */
export function createScrollSignals() {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const autoScrollDisabled$ = state(false);

  const setScrollContainer$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      set(internalScrollContainer$, el);

      let lastKnownScrollTop = el.scrollTop;

      const onScroll = () => {
        const distanceFromBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom <= AT_BOTTOM_THRESHOLD) {
          set(autoScrollDisabled$, false);
        } else if (el.scrollTop < lastKnownScrollTop) {
          set(autoScrollDisabled$, true);
        }
        lastKnownScrollTop = el.scrollTop;
      };

      el.addEventListener("scroll", onScroll, { passive: true });
      signal.addEventListener("abort", () => {
        el.removeEventListener("scroll", onScroll);
        set(internalScrollContainer$, null);
      });
    }),
  );

  const autoScroll$ = command(({ get }) => {
    if (get(autoScrollDisabled$)) {
      return;
    }
    const scrollEl = get(internalScrollContainer$);
    if (!scrollEl) {
      return;
    }
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  const scrollToBottom$ = command(({ get }) => {
    const scrollEl = get(internalScrollContainer$);
    if (!scrollEl) {
      return;
    }
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  return { setScrollContainer$, autoScroll$, scrollToBottom$ };
}
