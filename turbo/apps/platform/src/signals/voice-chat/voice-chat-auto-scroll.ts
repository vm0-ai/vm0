import { command, state } from "ccstate";
import { onRef } from "../utils.ts";

const NEAR_BOTTOM_THRESHOLD = 80;

// --- Transcript panel ---

const transcriptScrollContainer$ = state<HTMLElement | null>(null);

export const setTranscriptScrollContainer$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(transcriptScrollContainer$, null);
    });
    set(transcriptScrollContainer$, el);
  }),
);

export const autoScrollTranscript$ = command(({ get }) => {
  const el = get(transcriptScrollContainer$);
  if (!el) {
    return;
  }
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceFromBottom < NEAR_BOTTOM_THRESHOLD) {
    el.scrollTop = el.scrollHeight;
  }
});

// --- Events panel ---

const eventsScrollContainer$ = state<HTMLElement | null>(null);

export const setEventsScrollContainer$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(eventsScrollContainer$, null);
    });
    set(eventsScrollContainer$, el);
  }),
);

export const autoScrollEvents$ = command(({ get }) => {
  const el = get(eventsScrollContainer$);
  if (!el) {
    return;
  }
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceFromBottom < NEAR_BOTTOM_THRESHOLD) {
    el.scrollTop = el.scrollHeight;
  }
});
