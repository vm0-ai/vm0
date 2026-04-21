import { command, computed, state } from "ccstate";
import { talkDraft$ } from "./chat-draft.ts";
import { getRandomPrompts } from "../../views/zero-page/zero-ideation-data.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { orgModelProviders$ } from "../external/org-model-providers.ts";

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

// Discriminated union so "user hasn't picked anything" (→ seed from org
// default) stays distinguishable from "user explicitly picked inherit" (→
// null). Mirrors the thread-page model selection factory.
const internalChatPageUserOverride$ = state<
  { kind: "unset" } | { kind: "set"; value: ModelProviderSelection | null }
>({ kind: "unset" });

export const chatPageModelSelection$ = computed(
  async (get): Promise<ModelProviderSelection | null> => {
    const user = get(internalChatPageUserOverride$);
    if (user.kind === "set") {
      return user.value;
    }
    // Seed from the org default so what the picker shows is what the send
    // body carries. See the matching note in `createModelSelection`
    // (create-chat-thread.ts) for the full reasoning.
    const { modelProviders } = await get(orgModelProviders$);
    const defaultProvider = modelProviders.find((p) => {
      return p.isDefault;
    });
    if (defaultProvider?.selectedModel) {
      return {
        modelProviderId: defaultProvider.id,
        selectedModel: defaultProvider.selectedModel,
      };
    }
    return null;
  },
);

export const setChatPageModelSelection$ = command(
  ({ set }, value: ModelProviderSelection | null) => {
    set(internalChatPageUserOverride$, { kind: "set", value });
  },
);
