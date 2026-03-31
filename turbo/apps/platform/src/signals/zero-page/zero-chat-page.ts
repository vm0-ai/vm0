import { command, computed, state } from "ccstate";
import { talkDraft$ } from "./chat-draft.ts";

// ---------------------------------------------------------------------------
// Landing page local UI state for ZeroChatPage
// ---------------------------------------------------------------------------

const INITIAL_TAGLINE_INDEX = Math.floor(Math.random() * 18);

/** Talk page input — delegates to the talk draft. */
export const chatPageInput$ = computed((get) => get(get(talkDraft$).input$));
export const setChatPageInput$ = command(({ get, set }, value: string) => {
  set(get(talkDraft$).setInput$, value);
});

const internalTaglineIndex$ = state(INITIAL_TAGLINE_INDEX);
export const chatPageTaglineIndex$ = computed((get) =>
  get(internalTaglineIndex$),
);
