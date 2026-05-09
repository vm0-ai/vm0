import { command, computed, state } from "ccstate";
import type { SendMode } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { updateUserPreference$, userPreferences$ } from "./user-preferences.ts";
import { sendMode$ } from "../../send-mode.ts";
import { searchParams$, updateSearchParams$ } from "../../route.ts";

// ---------------------------------------------------------------------------
// Preferences tab state
// ---------------------------------------------------------------------------

export type PreferencesTab =
  | "appearance"
  | "timezone"
  | "model-configuration"
  | "debug";

const DEFAULT_PREFERENCES_TAB: PreferencesTab = "appearance";

function normalizePreferencesTab(value: string | null): PreferencesTab {
  if (value === "personal-providers") {
    return "model-configuration";
  }
  if (
    value === "timezone" ||
    value === "model-configuration" ||
    value === "debug"
  ) {
    return value;
  }
  return DEFAULT_PREFERENCES_TAB;
}

export const preferencesTab$ = computed((get) => {
  return normalizePreferencesTab(get(searchParams$).get("tab"));
});

export const setPreferencesTab$ = command(({ get, set }, value: string) => {
  const tab = normalizePreferencesTab(value);
  const next = new URLSearchParams(get(searchParams$));
  if (tab === DEFAULT_PREFERENCES_TAB) {
    next.delete("tab");
  } else {
    next.set("tab", tab);
  }
  set(updateSearchParams$, next);
});

// ---------------------------------------------------------------------------
// Send mode
// ---------------------------------------------------------------------------

/**
 * Tracks the send mode value most recently submitted via updateSendMode$.
 * Used by the view to show an optimistic spinner on the correct button.
 * Cleared automatically when the command completes or fails.
 */
const internalPendingSendMode$ = state<SendMode | null>(null);

export const pendingSendMode$ = computed((get) => {
  return get(internalPendingSendMode$);
});

/**
 * Update send mode preference. After saving, await the refetched value so the
 * UI never flashes back to the old value before the signal updates.
 */
export const updateSendMode$ = command(
  async ({ get, set }, value: SendMode, signal: AbortSignal) => {
    set(internalPendingSendMode$, value);
    await set(updateUserPreference$, { sendMode: value }, signal).finally(
      () => {
        set(internalPendingSendMode$, null);
      },
    );
    signal.throwIfAborted();
    // Await the refetched sendMode so the optimistic UI is consistent.
    await get(sendMode$);
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Capture network bodies
// ---------------------------------------------------------------------------

export const captureNetworkBodiesRemaining$ = computed(async (get) => {
  const prefs = await get(userPreferences$);
  return prefs.captureNetworkBodiesRemaining;
});

export const updateCaptureNetworkBodies$ = command(
  async ({ set }, remaining: number, signal: AbortSignal) => {
    await set(
      updateUserPreference$,
      { captureNetworkBodiesRemaining: remaining },
      signal,
    );
  },
);
