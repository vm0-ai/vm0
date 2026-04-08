import { command, computed, state } from "ccstate";
import type { SendMode } from "@vm0/core";
import { toast } from "@vm0/ui/components/ui/sonner";
import { updateUserPreference$, userPreferences$ } from "./user-preferences.ts";
import { sendMode$ } from "../../send-mode.ts";
import { throwIfAbort } from "../../utils.ts";

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
// Send mode saving state
// ---------------------------------------------------------------------------

const internalSendModeSaving$ = state<SendMode | null>(null);

export const sendModeSaving$ = computed((get) => {
  return get(internalSendModeSaving$);
});

/**
 * Update send mode preference and clear saving state once the refetched value
 * matches. This keeps the optimistic UI in the signals layer instead of relying
 * on a React useEffect in the view.
 */
export const updateSendMode$ = command(
  async ({ get, set }, value: SendMode, signal: AbortSignal) => {
    set(internalSendModeSaving$, value);
    // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove — use accept() auto-toast
    try {
      await set(updateUserPreference$, { sendMode: value }, signal);
      // After the command completes the refetch has been triggered.
      // Await the refetched sendMode so the UI never flashes back to the old value.
      const fetched = await get(sendMode$);
      signal.throwIfAborted();
      if (fetched === value) {
        set(internalSendModeSaving$, null);
      }
    } catch (error) {
      throwIfAbort(error);
      set(internalSendModeSaving$, null);
      toast.error("Failed to save send mode preference");
    }
  },
);

// ---------------------------------------------------------------------------
// Capture network bodies
// ---------------------------------------------------------------------------

export const captureNetworkBodiesRemaining$ = computed(async (get) => {
  const prefs = await get(userPreferences$);
  return prefs.captureNetworkBodiesRemaining;
});

const internalCaptureSaving$ = state(false);

export const captureSaving$ = computed((get) => {
  return get(internalCaptureSaving$);
});

export const updateCaptureNetworkBodies$ = command(
  async ({ set }, remaining: number, signal: AbortSignal) => {
    set(internalCaptureSaving$, true);
    // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove — use accept() auto-toast
    try {
      await set(
        updateUserPreference$,
        { captureNetworkBodiesRemaining: remaining },
        signal,
      );
    } catch (error) {
      throwIfAbort(error);
      toast.error("Failed to save capture preference");
    } finally {
      set(internalCaptureSaving$, false);
    }
  },
);
