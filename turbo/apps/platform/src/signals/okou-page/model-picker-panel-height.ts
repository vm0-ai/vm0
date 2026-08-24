import { command } from "ccstate";
import { onRef } from "../utils.ts";

/**
 * Switching model category swaps one list of rows for another of a different
 * length, so the popover used to jump to its new height in a single frame.
 *
 * `180ms ease` is the same pair the dialog uses in `globals.css`, so resizing
 * the popover borrows the app's existing motion rather than introducing a
 * second vocabulary for the same kind of movement.
 */
const PANEL_HEIGHT_DURATION_MS = 180;

/**
 * The rows arrive faster than the box that carries them: a shorter fade reads
 * as "the new list settled first", where matching the height duration would
 * read as one slow cross-dissolve.
 */
const PANEL_CONTENT_FADE_MS = 120;

/** The rows never fade from fully transparent -- the list stays legible. */
const PANEL_CONTENT_FADE_FROM = 0.4;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The popup's own height follows its list, so the list is what gets measured
 * and the popup is what gets animated. Observing the popup instead would make
 * every animation frame feed the next one.
 */
const SELECT_LIST_SELECTOR = '[data-slot="select-list"]';

/**
 * Sticky chrome stays put while the rows under it change, so the header keeps
 * its opacity through the swap.
 */
const PANEL_HEADER_SELECTOR = "[data-model-picker-header]";

/**
 * A media category replaces the model rows, so the selected chat model stays in
 * the list as a 1px, transparent row the select can still measure. A keyframe
 * outranks the class that hides it, so fading that row in would print the model
 * name over the header for the length of the fade.
 */
const PANEL_MEASUREMENT_ROW_SELECTOR = '[aria-hidden="true"]';

/**
 * Animates the model picker popup between the heights its category panels ask
 * for. Attach to the popup; it finds the list underneath on its own.
 *
 * In a test environment every `offsetHeight` is 0, so no height change is ever
 * observed and nothing animates.
 */
export const modelPickerPanelHeightRef$ = onRef(
  command((_visitor, popup: HTMLElement, signal: AbortSignal) => {
    const list = popup.querySelector<HTMLElement>(SELECT_LIST_SELECTOR);
    if (!list) {
      // `SelectContent` always renders the list this ref is attached above, so
      // a miss means the slot was renamed or the popup restructured. Fail
      // loudly instead of silently dropping the animation.
      throw new Error(`Select popup has no ${SELECT_LIST_SELECTOR}`);
    }

    const win = popup.ownerDocument.defaultView;
    let previousHeight: number | null = null;
    let heightAnimation: Animation | null = null;

    const observer = new ResizeObserver(() => {
      const nextHeight = list.offsetHeight;
      if (previousHeight === nextHeight) {
        return;
      }
      const fromHeight = previousHeight;
      previousHeight = nextHeight;
      // The first measurement is the baseline: there is no earlier height to
      // travel from, and animating from 0 would read as the popup unfolding.
      if (fromHeight === null) {
        return;
      }
      if (win?.matchMedia(REDUCED_MOTION_QUERY).matches === true) {
        return;
      }

      // A category switched mid-flight replaces the trip in progress rather
      // than composing with it.
      heightAnimation?.cancel();
      // The popup scrolls its own overflow, and the growing half of the
      // animation is briefly shorter than the list it holds -- without this
      // the scrollbar flickers in and back out on every switch.
      popup.style.overflowY = "hidden";
      const animation = popup.animate(
        [{ height: `${fromHeight}px` }, { height: `${nextHeight}px` }],
        { duration: PANEL_HEIGHT_DURATION_MS, easing: "ease" },
      );
      heightAnimation = animation;
      const restoreOverflow = () => {
        // `cancel` is delivered asynchronously, so a superseded animation can
        // report back after its replacement already hid the overflow again.
        if (heightAnimation !== animation) {
          return;
        }
        popup.style.overflowY = "";
      };
      animation.addEventListener("finish", restoreOverflow);
      animation.addEventListener("cancel", restoreOverflow);

      for (const row of list.children) {
        if (!(row instanceof HTMLElement)) {
          continue;
        }
        if (
          row.matches(PANEL_HEADER_SELECTOR) ||
          row.matches(PANEL_MEASUREMENT_ROW_SELECTOR)
        ) {
          continue;
        }
        row.animate([{ opacity: PANEL_CONTENT_FADE_FROM }, { opacity: 1 }], {
          duration: PANEL_CONTENT_FADE_MS,
          easing: "ease",
        });
      }
    });

    observer.observe(list);
    signal.addEventListener("abort", () => {
      observer.disconnect();
      heightAnimation?.cancel();
    });
  }),
);
