import { command, computed, state } from "ccstate";
import { talkDraft$ } from "./chat-draft.ts";
import { getRandomPrompts } from "../../views/zero-page/zero-ideation-data.ts";
import {
  featureSwitch$,
  modelFirstModelProviderEnabled$,
} from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { currentChatAgent$ } from "../agent-chat.ts";
import { composerModelProviders$ } from "./composer-model-providers.ts";
import {
  resolveEffectiveAgentDefaultSelection,
  resolveModelFirstAgentDefaultSelection,
} from "./model-provider-default.ts";

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
// Suggested prompts — filtered by active feature switches
// ---------------------------------------------------------------------------

export const suggestedPrompts$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return getRandomPrompts(2, features);
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
    // Priority: agent default > workspace default. Seed here (rather than
    // letting the picker fall back to its null-value display) so the model
    // shown next to Send is the exact model the send body will carry. See
    // the matching note in
    // `createModelSelection` (create-chat-thread.ts) for the full
    // display/run mismatch reasoning.
    const agent = await get(currentChatAgent$);
    if (get(modelFirstModelProviderEnabled$)) {
      const policies = await get(orgModelPolicies$);
      return resolveModelFirstAgentDefaultSelection({ agent, policies });
    }
    const composerProviders = await get(composerModelProviders$);
    return resolveEffectiveAgentDefaultSelection({
      agent,
      providers: composerProviders.providers,
    });
  },
);

export const chatPageAgentModelDefault$ = computed(
  async (get): Promise<ModelProviderSelection | null> => {
    const agent = await get(currentChatAgent$);
    if (get(modelFirstModelProviderEnabled$)) {
      const policies = await get(orgModelPolicies$);
      return resolveModelFirstAgentDefaultSelection({ agent, policies });
    }
    const composerProviders = await get(composerModelProviders$);
    return resolveEffectiveAgentDefaultSelection({
      agent,
      providers: composerProviders.providers,
    });
  },
);

export const setChatPageModelSelection$ = command(
  ({ set }, value: ModelProviderSelection | null) => {
    set(internalChatPageUserOverride$, { kind: "set", value });
  },
);

export const resetChatPageModelSelection$ = command(({ set }) => {
  set(internalChatPageUserOverride$, { kind: "unset" });
});
