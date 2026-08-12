import { createScrollSignals } from "../auto-scroll.ts";

export const {
  setScrollContainer$: setActivityDetailScrollContainer$,
  scrollToBottom$: scrollToBottomActivityDetail$,
} = createScrollSignals();
