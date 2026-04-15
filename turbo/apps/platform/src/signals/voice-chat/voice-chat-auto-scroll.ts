import { createScrollSignals } from "../auto-scroll.ts";

// --- Transcript panel ---

const transcriptScrollSignals = createScrollSignals();
export const setTranscriptScrollContainer$ =
  transcriptScrollSignals.setScrollContainer$;
export const autoScrollTranscript$ = transcriptScrollSignals.autoScroll$;

// --- Events panel ---

const eventsScrollSignals = createScrollSignals();
export const setEventsScrollContainer$ =
  eventsScrollSignals.setScrollContainer$;
export const autoScrollEvents$ = eventsScrollSignals.autoScroll$;
