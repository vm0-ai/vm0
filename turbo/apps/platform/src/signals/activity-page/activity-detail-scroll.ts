import { createScrollSignals } from "../auto-scroll.ts";

export const {
  setScrollContainer$: setActivityDetailScrollContainer$,
  autoScroll$: autoScrollActivityDetail$,
  scrollToBottom$: scrollToBottomActivityDetail$,
} = createScrollSignals();
