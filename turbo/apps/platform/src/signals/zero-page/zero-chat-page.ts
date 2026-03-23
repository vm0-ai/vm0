import { command, computed, state } from "ccstate";

// ---------------------------------------------------------------------------
// Landing page local UI state for ZeroChatPage
// ---------------------------------------------------------------------------

const INITIAL_TAGLINE_INDEX = Math.floor(Math.random() * 18);

const internalInput$ = state("");
export const chatPageInput$ = computed((get) => get(internalInput$));
export const setChatPageInput$ = command(({ set }, value: string) => {
  set(internalInput$, value);
});

const internalTaglineIndex$ = state(INITIAL_TAGLINE_INDEX);
export const chatPageTaglineIndex$ = computed((get) =>
  get(internalTaglineIndex$),
);
