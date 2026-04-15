import { createScrollSignals } from "../auto-scroll.ts";

// --- Transcript panel ---

export const {
  setScrollContainer$: setTranscriptScrollContainer$,
  autoScroll$: autoScrollTranscript$,
} = createScrollSignals();

// --- Events panel ---

export const {
  setScrollContainer$: setEventsScrollContainer$,
  autoScroll$: autoScrollEvents$,
} = createScrollSignals();
