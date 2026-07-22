import { command, computed, state } from "ccstate";
import { talkDraft$ } from "./chat-draft.ts";
import { createWorkflowComposerSignals } from "./tiptap-workflow-composer.ts";
import { getRandomPrompts } from "../../views/zero-page/zero-ideation-data.ts";
import {
  codexFastModeEnabled$,
  featureSwitch$,
} from "../external/feature-switch.ts";
import { connectorCatalogStatusByRef$ } from "../external/connectors.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import {
  applyCodexFastModeDefault,
  isCodexFastModeAvailableForSelection,
  resolveModelFirstUserDefaultSelection,
} from "./model-default-selection.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  codexFastModeLocalDefault$,
  setCodexFastModeLocalDefault$,
} from "./codex-fast-local-default.ts";
import { personalModelProvider$ } from "./model-first-personal-oauth.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "./settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "./settings/codex-device-auth.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { createComposerConnectorSignals } from "./zero-connectors.ts";

// ---------------------------------------------------------------------------
// Landing page local UI state for ZeroChatPage
// ---------------------------------------------------------------------------

export const chatPageInput$ = computed((get) => {
  return get(get(talkDraft$).input$);
});
export const setChatPageInput$ = command(({ get, set }, value: string) => {
  set(get(talkDraft$).setInput$, value);
});

export const chatPageWorkflowComposer$ = computed((get) => {
  return createWorkflowComposerSignals(get(talkDraft$));
});

export const chatPageComposerConnectors = createComposerConnectorSignals(
  currentChatAgentRecordId$,
);

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
      if (user.value?.codexServiceTier !== "fast") {
        return user.value;
      }
      const policies = await get(orgModelPolicies$);
      return isCodexFastModeAvailableForSelection({
        policies,
        selectedModel: user.value.selectedModel,
        codexFastModeEnabled: get(codexFastModeEnabled$),
      })
        ? user.value
        : { selectedModel: user.value.selectedModel };
    }
    const policies = await get(orgModelPolicies$);
    const userPreference = await get(userModelPreference$);
    const codexFastModeDefault = await get(codexFastModeLocalDefault$);
    const featureSwitches = get(featureSwitch$);
    return applyCodexFastModeDefault({
      selection: resolveModelFirstUserDefaultSelection({
        userPreference,
        policies,
      }),
      policies,
      codexFastModeEnabled:
        featureSwitches[FeatureSwitchKey.CodexFastMode] ?? false,
      codexFastModeDefault,
    });
  },
);

export const chatPageSelectedModelOauthAvailable$ = computed(
  async (get): Promise<boolean> => {
    const selection = await get(chatPageModelSelection$);
    if (selection === null) {
      return true;
    }
    const status = (await get(personalModelProvider$))[selection.selectedModel];
    return status === undefined || status.status === "connected";
  },
);

export const configureChatPageSelectedModel$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const selection = await get(chatPageModelSelection$);
    signal.throwIfAborted();
    if (selection === null) {
      return;
    }
    const status = (await get(personalModelProvider$))[selection.selectedModel];
    signal.throwIfAborted();
    if (status === undefined || status.status === "connected") {
      return;
    }
    const mode = status.status === "needs_reconnect" ? "reconnect" : "connect";
    if (status.providerType === "claude-code-oauth-token") {
      await set(openClaudeCodeDeviceAuthDialogPersonal$, mode, signal);
      return;
    }
    await set(openCodexDeviceAuthDialogPersonal$, mode, signal);
  },
);

export const setChatPageModelSelection$ = command(
  ({ set }, value: ModelProviderSelection | null) => {
    set(internalChatPageUserOverride$, { kind: "set", value });
  },
);

export const updateCodexFastModeDefaultForSelection$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const policies = await get(orgModelPolicies$);
    signal.throwIfAborted();
    if (
      !isCodexFastModeAvailableForSelection({
        policies,
        selectedModel: selection?.selectedModel,
        codexFastModeEnabled: get(codexFastModeEnabled$),
      })
    ) {
      return;
    }
    await set(
      setCodexFastModeLocalDefault$,
      selection?.codexServiceTier === "fast",
      signal,
    );
  },
);

export const resetChatPageModelSelection$ = command(({ set }) => {
  set(internalChatPageUserOverride$, { kind: "unset" });
});
