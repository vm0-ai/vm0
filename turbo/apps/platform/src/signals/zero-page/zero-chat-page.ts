import { command, computed, state } from "ccstate";
import { talkDraft$ } from "./chat-draft.ts";
import { getRandomPrompts } from "../../views/zero-page/zero-ideation-data.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { connectorCatalogStatusByRef$ } from "../external/connectors.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { resolveModelFirstUserDefaultSelection } from "./model-default-selection.ts";
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
// Suggested prompts — filtered by active feature switches and connector catalog
// ---------------------------------------------------------------------------

export const unfilteredSuggestedPrompts$ = computed((get) => {
  const features = get(featureSwitch$);
  return getRandomPrompts(2, { features });
});

export const suggestedPrompts$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  const connectorStatusByRef = await get(connectorCatalogStatusByRef$);
  return getRandomPrompts(2, {
    features,
    visibleConnectorRefs: new Set(connectorStatusByRef.keys()),
  });
});

// ---------------------------------------------------------------------------
// Landing-page composer model selection
// ---------------------------------------------------------------------------

// Discriminated union so "user hasn't picked anything" can resolve to the
// current model-first default while "user explicitly picked inherit" stays null.
const internalChatPageUserOverride$ = state<
  { kind: "unset" } | { kind: "set"; value: ModelProviderSelection | null }
>({ kind: "unset" });

export const chatPageModelSelection$ = computed(
  async (get): Promise<ModelProviderSelection | null> => {
    const user = get(internalChatPageUserOverride$);
    if (user.kind === "set") {
      return user.value;
    }
    const policies = await get(orgModelPolicies$);
    const userPreference = await get(userModelPreference$);
    return resolveModelFirstUserDefaultSelection({
      userPreference,
      policies,
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
