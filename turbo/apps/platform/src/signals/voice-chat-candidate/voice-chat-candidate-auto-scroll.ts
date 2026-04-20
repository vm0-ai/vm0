import { createScrollSignals } from "../auto-scroll.ts";

// --- Voice chat candidate scroll container ---

export const { setScrollContainer$: setVoiceChatCandidateScrollContainer$ } =
  createScrollSignals();
