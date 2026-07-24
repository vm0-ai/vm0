import { command, computed, state } from "ccstate";

import type { BrowserSessionSignals } from "../chat-page/browser-session-block.ts";

const browserSessionPageSignalsState$ = state<BrowserSessionSignals | null>(
  null,
);

export const browserSessionPageSignals$ = computed((get) => {
  return get(browserSessionPageSignalsState$);
});

export const setBrowserSessionPageSignals$ = command(
  ({ set }, value: BrowserSessionSignals | null) => {
    set(browserSessionPageSignalsState$, value);
  },
);
