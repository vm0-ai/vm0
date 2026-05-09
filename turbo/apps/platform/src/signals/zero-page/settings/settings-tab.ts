import { command, computed, state } from "ccstate";
import type { Tone } from "../../../views/zero-page/zero-tone-constants.ts";
import type { ModelProviderSelection } from "../../../views/zero-page/components/model-provider-picker.tsx";

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

const internalAgentName$ = state("");
export const settingsAgentName$ = computed((get) => {
  return get(internalAgentName$);
});
export const setSettingsAgentName$ = command(({ set }, value: string) => {
  set(internalAgentName$, value);
});

const internalDesc$ = state("");
export const settingsDesc$ = computed((get) => {
  return get(internalDesc$);
});
export const setSettingsDesc$ = command(({ set }, value: string) => {
  set(internalDesc$, value);
});

const internalTone$ = state<Tone>("professional");
export const settingsTone$ = computed((get) => {
  return get(internalTone$);
});
export const setSettingsTone$ = command(({ set }, value: Tone) => {
  set(internalTone$, value);
});

const internalAvatarUrl$ = state<string | null>(null);
export const settingsAvatarUrl$ = computed((get) => {
  return get(internalAvatarUrl$);
});
export const setSettingsAvatarUrl$ = command(
  ({ set }, value: string | null) => {
    set(internalAvatarUrl$, value);
  },
);

const internalModelSelection$ = state<ModelProviderSelection | null>(null);
export const settingsModelSelection$ = computed((get) => {
  return get(internalModelSelection$);
});
export const setSettingsModelSelection$ = command(
  ({ set }, value: ModelProviderSelection | null) => {
    set(internalModelSelection$, value);
  },
);

const internalPreferPersonalProvider$ = state(false);
export const settingsPreferPersonalProvider$ = computed((get) => {
  return get(internalPreferPersonalProvider$);
});

// ---------------------------------------------------------------------------
// Saved settings state (for dirty detection)
// ---------------------------------------------------------------------------

interface SavedSettings {
  name: string;
  description: string;
  tone: Tone;
  avatarUrl: string | null;
  modelSelection: ModelProviderSelection | null;
  preferPersonalProvider: boolean;
}

const internalSavedSettings$ = state<SavedSettings>({
  name: "",
  description: "",
  tone: "professional",
  avatarUrl: null,
  modelSelection: null,
  preferPersonalProvider: false,
});

export const settingsDirty$ = computed((get) => {
  const saved = get(internalSavedSettings$);
  const currentModel = get(internalModelSelection$);
  const savedModel = saved.modelSelection;
  const modelChanged =
    currentModel?.modelProviderId !== savedModel?.modelProviderId ||
    currentModel?.selectedModel !== savedModel?.selectedModel;
  return (
    get(internalAgentName$) !== saved.name ||
    get(internalDesc$) !== saved.description ||
    get(internalTone$) !== saved.tone ||
    get(internalAvatarUrl$) !== saved.avatarUrl ||
    modelChanged ||
    get(internalPreferPersonalProvider$) !== saved.preferPersonalProvider
  );
});

// ---------------------------------------------------------------------------
// Form source tracking — allows idempotent init from render
// ---------------------------------------------------------------------------

interface FormSource {
  name: string;
  description: string;
  tone: Tone;
  avatarUrl: string | null;
  modelSelection: ModelProviderSelection | null;
  preferPersonalProvider: boolean;
}

const internalFormSource$ = state<FormSource | null>(null);

// ---------------------------------------------------------------------------
// Initialize form state (idempotent — skips if source matches)
// ---------------------------------------------------------------------------

export const initSettingsForm$ = command(({ get, set }, opts: FormSource) => {
  const current = get(internalFormSource$);
  if (
    current !== null &&
    current.name === opts.name &&
    current.description === opts.description &&
    current.tone === opts.tone &&
    current.avatarUrl === opts.avatarUrl &&
    current.modelSelection?.modelProviderId ===
      opts.modelSelection?.modelProviderId &&
    current.modelSelection?.selectedModel ===
      opts.modelSelection?.selectedModel &&
    current.preferPersonalProvider === opts.preferPersonalProvider
  ) {
    return;
  }
  set(internalFormSource$, opts);
  set(internalAgentName$, opts.name);
  set(internalDesc$, opts.description);
  set(internalTone$, opts.tone);
  set(internalAvatarUrl$, opts.avatarUrl);
  set(internalModelSelection$, opts.modelSelection);
  set(internalPreferPersonalProvider$, opts.preferPersonalProvider);
  set(internalSavedSettings$, {
    name: opts.name,
    description: opts.description,
    tone: opts.tone,
    avatarUrl: opts.avatarUrl,
    modelSelection: opts.modelSelection,
    preferPersonalProvider: opts.preferPersonalProvider,
  });
});

// ---------------------------------------------------------------------------
// Reset form to saved state (discard changes)
// ---------------------------------------------------------------------------

export const resetSettingsForm$ = command(({ get, set }) => {
  const saved = get(internalSavedSettings$);
  set(internalAgentName$, saved.name);
  set(internalDesc$, saved.description);
  set(internalTone$, saved.tone);
  set(internalAvatarUrl$, saved.avatarUrl);
  set(internalModelSelection$, saved.modelSelection);
  set(internalPreferPersonalProvider$, saved.preferPersonalProvider);
});

// ---------------------------------------------------------------------------
// Mark current form values as saved
// ---------------------------------------------------------------------------

export const markSettingsSaved$ = command(({ get, set }) => {
  set(internalSavedSettings$, {
    name: get(internalAgentName$),
    description: get(internalDesc$),
    tone: get(internalTone$),
    avatarUrl: get(internalAvatarUrl$),
    modelSelection: get(internalModelSelection$),
    preferPersonalProvider: get(internalPreferPersonalProvider$),
  });
});

// ---------------------------------------------------------------------------
// Delete agent command
// ---------------------------------------------------------------------------

export const deleteAgent$ = command(
  async (
    _ctx,
    deleteFn: () => Promise<void>,
    _signal: AbortSignal,
  ): Promise<void> => {
    await deleteFn();
  },
);
