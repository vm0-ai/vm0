import { command } from "ccstate";
import { onRef } from "../utils.ts";

// Keep in sync with the transition duration in views/css/index.css.
const STEER_ACKNOWLEDGEMENT_SWEEP_MS = 520;

// The acknowledgement label is repainted in place rather than replaced. Both
// wordings sit in one box so a single feathered gradient boundary sweeps across
// both of them: the previous wording is erased and the new one drawn without
// either moving a pixel. The box width travels with the boundary so the divider
// rule beside the label grows or shrinks to the new wording instead of leaving
// a gap.
//
// The previous wording is read back off the row rather than rendered, because
// the label element is remounted on every change and React has no memory of
// what it said last. A thread opened at three steers has no earlier wording to
// erase, so it simply draws.
const sweepSteerAcknowledgementOnRef$ = command(
  (_, el: HTMLElement, signal: AbortSignal) => {
    const row = el.parentElement;
    const outgoing = el.querySelector("[data-steer-acknowledgement-outgoing]");
    const label = el.dataset.steerAcknowledgementLabel;
    if (
      row === null ||
      !(outgoing instanceof HTMLElement) ||
      label === undefined
    ) {
      return;
    }

    const previousLabel = row.dataset.steerAcknowledgedLabel;
    row.dataset.steerAcknowledgedLabel = label;
    if (previousLabel === undefined || previousLabel === label) {
      return;
    }
    outgoing.textContent = previousLabel;

    // The box is still auto-sized to the incoming wording here, and the outgoing
    // layer is stretched across that same box so both masks share one reference
    // width — which means the outgoing width has to be read off its text rather
    // than its border box.
    const incomingWidth = el.getBoundingClientRect().width;
    const outgoingRange = document.createRange();
    outgoingRange.selectNodeContents(outgoing);
    const outgoingWidth = outgoingRange.getBoundingClientRect().width;

    el.style.width = `${String(outgoingWidth)}px`;
    el.style.setProperty("--zero-steer-ack-sweep", "100%");
    // Read layout back so the resting state lands as its own style change and
    // the sweep animates from it instead of being collapsed into one update.
    el.getBoundingClientRect();
    el.dataset.steerAcknowledgementSweeping = "";
    el.style.width = `${String(incomingWidth)}px`;
    el.style.setProperty("--zero-steer-ack-sweep", "0%");

    const timer = window.setTimeout(() => {
      delete el.dataset.steerAcknowledgementSweeping;
      // Drop back to the intrinsic width so later font or zoom changes keep the
      // rule beside the label, and stop the spent wording from being selectable.
      el.style.removeProperty("width");
      outgoing.textContent = "";
    }, STEER_ACKNOWLEDGEMENT_SWEEP_MS);

    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
    });
  },
);

export const steerAcknowledgementRef$ = onRef(sweepSteerAcknowledgementOnRef$);
