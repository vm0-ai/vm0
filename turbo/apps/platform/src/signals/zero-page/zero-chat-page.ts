import { command, computed, state } from "ccstate";
import { talkDraft$ } from "./chat-draft.ts";
import { getRandomPrompts } from "../../views/zero-page/zero-ideation-data.ts";

// ---------------------------------------------------------------------------
// Landing page local UI state for ZeroChatPage
// ---------------------------------------------------------------------------

const INITIAL_TAGLINE_INDEX = Math.floor(Math.random() * 18);

/** Talk page input — delegates to the talk draft. */
export const chatPageInput$ = computed((get) => {
  return get(get(talkDraft$).input$);
});
export const setChatPageInput$ = command(({ get, set }, value: string) => {
  set(get(talkDraft$).setInput$, value);
});

const internalTaglineIndex$ = state(INITIAL_TAGLINE_INDEX);
export const chatPageTaglineIndex$ = computed((get) => {
  return get(internalTaglineIndex$);
});

// ---------------------------------------------------------------------------
// Suggested prompts — initialized once at module load, never modified
// ---------------------------------------------------------------------------

const internalSuggestedPrompts$ = state(getRandomPrompts(2));
export const suggestedPrompts$ = computed((get) => {
  return get(internalSuggestedPrompts$);
});
