import { command, state } from "ccstate";

const NEAR_BOTTOM_THRESHOLD = 80;

// --- Transcript panel ---

const transcriptScrollContainer$ = state<HTMLElement | null>(null);

export const setTranscriptScrollContainer$ = command(
  ({ set }, el: HTMLElement | null) => {
    set(transcriptScrollContainer$, el);
  },
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

export const setEventsScrollContainer$ = command(
  ({ set }, el: HTMLElement | null) => {
    set(eventsScrollContainer$, el);
  },
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
