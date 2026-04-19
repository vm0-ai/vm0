import { command, computed, state } from "ccstate";
import { talkDraft$ } from "./chat-draft.ts";
import { getRandomPrompts } from "../../views/zero-page/zero-ideation-data.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

// ---------------------------------------------------------------------------
// Landing page local UI state for ZeroChatPage
// ---------------------------------------------------------------------------

export const chatPageInput$ = computed((get) => {
  return get(get(talkDraft$).input$);
});
export const setChatPageInput$ = command(({ get, set }, value: string) => {
  set(get(talkDraft$).setInput$, value);
});

const internalTaglineIndex$ = state(Math.floor(Math.random() * 18));
export const reloadTagline$ = command(({ set }) => {
  set(internalTaglineIndex$, Math.floor(Math.random() * 18));
});

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

// ---------------------------------------------------------------------------
// Landing-page composer model override
// ---------------------------------------------------------------------------

// Before a thread exists there's nothing on the server to seed from, so a plain
// state signal is sufficient. `null` = inherit agent/org default.
const internalChatPageModelSelection$ = state<ModelProviderSelection | null>(
  null,
);
export const chatPageModelSelection$ = computed((get) => {
  return get(internalChatPageModelSelection$);
});
export const setChatPageModelSelection$ = command(
  ({ set }, value: ModelProviderSelection | null) => {
    set(internalChatPageModelSelection$, value);
  },
);
