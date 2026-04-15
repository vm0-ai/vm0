import { command, state } from "ccstate";
import { onRef } from "../utils.ts";

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
