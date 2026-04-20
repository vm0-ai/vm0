import { createScrollSignals } from "../auto-scroll.ts";

// --- Voice chat scroll container ---

export const { setScrollContainer$: setVoiceChatScrollContainer$ } =
  createScrollSignals();
