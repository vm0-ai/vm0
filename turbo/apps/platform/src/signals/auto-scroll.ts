import { command, state } from "ccstate";
import { onRef } from "./utils.ts";
import { logger } from "./log.ts";

const L = logger("AutoScroll");
const AT_BOTTOM_THRESHOLD = 10;

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
 */
export function createScrollSignals() {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const autoScrollDisabled$ = state(false);

  const setScrollContainer$ = onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      set(internalScrollContainer$, el);
      L.debug("container bound");

      let lastKnownScrollTop = el.scrollTop;

      const onScroll = () => {
        const distanceFromBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom <= AT_BOTTOM_THRESHOLD) {
          const wasDisabled = get(autoScrollDisabled$);
          set(autoScrollDisabled$, false);
          if (wasDisabled) {
            L.debug("re-enabled (at bottom)", scrollInfo(el));
          }
        } else if (el.scrollTop < lastKnownScrollTop) {
          const wasDisabled = get(autoScrollDisabled$);
          set(autoScrollDisabled$, true);
          if (!wasDisabled) {
            L.debug(
              "DISABLED (scrolled up)",
              scrollInfo(el),
              `lastKnown=${Math.round(lastKnownScrollTop)}`,
            );
          }
        }
        lastKnownScrollTop = el.scrollTop;
      };

      el.addEventListener("scroll", onScroll, { passive: true });

      const resizeObserver = new ResizeObserver(() => {
        const disabled = get(autoScrollDisabled$);
        L.debug("ResizeObserver fired", scrollInfo(el), `disabled=${disabled}`);
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
      L.debug("scrollToBottom$ SKIPPED (no container)");
      return;
    }
    L.debug("scrollToBottom$ → scrolling to bottom", scrollInfo(scrollEl));
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  return { setScrollContainer$, autoScroll$, scrollToBottom$ };
}
