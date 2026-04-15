import { createScrollSignals } from "../auto-scroll.ts";

// --- Transcript panel ---

export const { setScrollContainer$: setTranscriptScrollContainer$ } =
  createScrollSignals();

// --- Events panel ---

export const { setScrollContainer$: setEventsScrollContainer$ } =
  createScrollSignals();
