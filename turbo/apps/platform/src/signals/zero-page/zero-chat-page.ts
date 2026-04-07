import { command, computed, state } from "ccstate";
import { talkDraft$ } from "./chat-draft.ts";
import { getRandomPrompts } from "../../views/zero-page/zero-ideation-data.ts";

// ---------------------------------------------------------------------------
// Landing page local UI state for ZeroChatPage
// ---------------------------------------------------------------------------

export const chatPageInput$ = computed((get) => {
  return get(get(talkDraft$).input$);
});
export const setChatPageInput$ = command(({ get, set }, value: string) => {
  set(get(talkDraft$).setInput$, value);
});

const internalTaglineIndex$ = state(0);
export const reloadTagline$ = command(({ set }) => {
  set(internalTaglineIndex$, (x) => {
    return x + 1;
  });
});

export const chatPageTaglineIndex$ = computed((get) => {
  get(internalTaglineIndex$);
  return Math.floor(Math.random() * 18);
});

// ---------------------------------------------------------------------------
// Suggested prompts — initialized once at module load, never modified
// ---------------------------------------------------------------------------

const internalSuggestedPrompts$ = state(getRandomPrompts(2));
export const suggestedPrompts$ = computed((get) => {
  return get(internalSuggestedPrompts$);
});
