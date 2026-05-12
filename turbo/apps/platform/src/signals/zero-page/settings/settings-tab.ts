import { command, computed, state } from "ccstate";
import type { Tone } from "../../../views/zero-page/zero-tone-constants.ts";

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

const internalVisibility$ = state<"public" | "private">("public");
export const settingsVisibility$ = computed((get) => {
  return get(internalVisibility$);
});
export const setSettingsVisibility$ = command(
  ({ set }, value: "public" | "private") => {
    set(internalVisibility$, value);
  },
);

// ---------------------------------------------------------------------------
// Saved settings state (for dirty detection)
// ---------------------------------------------------------------------------

interface SavedSettings {
  name: string;
  description: string;
  tone: Tone;
  avatarUrl: string | null;
  visibility: "public" | "private";
}

const internalSavedSettings$ = state<SavedSettings>({
  name: "",
  description: "",
  tone: "professional",
  avatarUrl: null,
  visibility: "public",
});

export const settingsDirty$ = computed((get) => {
  const saved = get(internalSavedSettings$);
  return (
    get(internalAgentName$) !== saved.name ||
    get(internalDesc$) !== saved.description ||
    get(internalTone$) !== saved.tone ||
    get(internalAvatarUrl$) !== saved.avatarUrl ||
    get(internalVisibility$) !== saved.visibility
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
  visibility: "public" | "private";
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
    current.visibility === opts.visibility
  ) {
    return;
  }
  set(internalFormSource$, opts);
  set(internalAgentName$, opts.name);
  set(internalDesc$, opts.description);
  set(internalTone$, opts.tone);
  set(internalAvatarUrl$, opts.avatarUrl);
  set(internalVisibility$, opts.visibility);
  set(internalSavedSettings$, {
    name: opts.name,
    description: opts.description,
    tone: opts.tone,
    avatarUrl: opts.avatarUrl,
    visibility: opts.visibility,
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
  set(internalVisibility$, saved.visibility);
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
    visibility: get(internalVisibility$),
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
