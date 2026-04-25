import { command, computed, state } from "ccstate";
import type { SendMode } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { updateUserPreference$, userPreferences$ } from "./user-preferences.ts";
import { sendMode$ } from "../../send-mode.ts";

// ---------------------------------------------------------------------------
// Preferences tab state
// ---------------------------------------------------------------------------

const internalPreferencesTab$ = state("appearance");

export const preferencesTab$ = computed((get) => {
  return get(internalPreferencesTab$);
});

export const setPreferencesTab$ = command(({ set }, value: string) => {
  set(internalPreferencesTab$, value);
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
