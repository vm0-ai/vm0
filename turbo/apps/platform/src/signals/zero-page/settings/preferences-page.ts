import { command, computed, state } from "ccstate";
import type { SendMode } from "@vm0/core";
import { toast } from "@vm0/ui/components/ui/sonner";
import { updateNotificationPreference$ } from "./notification-settings.ts";
import { sendMode$ } from "../../send-mode.ts";
import { throwIfAbort } from "../../utils.ts";

// ---------------------------------------------------------------------------
// Preferences tab state
// ---------------------------------------------------------------------------

const internalPreferencesTab$ = state("appearance");

export const preferencesTab$ = computed((get) => get(internalPreferencesTab$));

export const setPreferencesTab$ = command(({ set }, value: string) => {
  set(internalPreferencesTab$, value);
});

// ---------------------------------------------------------------------------
// Send mode saving state
// ---------------------------------------------------------------------------

const internalSendModeSaving$ = state<SendMode | null>(null);

export const sendModeSaving$ = computed((get) => get(internalSendModeSaving$));

/**
 * Update send mode preference and clear saving state once the refetched value
 * matches. This keeps the optimistic UI in the signals layer instead of relying
 * on a React useEffect in the view.
 */
export const updateSendMode$ = command(
  async ({ get, set }, value: SendMode) => {
    set(internalSendModeSaving$, value);
    try {
      await set(updateNotificationPreference$, { sendMode: value });
      // After the command completes the refetch has been triggered.
      // Await the refetched sendMode so the UI never flashes back to the old value.
      const fetched = await get(sendMode$);
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
// Timezone saving state
// ---------------------------------------------------------------------------

const internalTimezoneSaving$ = state(false);

export const timezoneSaving$ = computed((get) => get(internalTimezoneSaving$));

export const setTimezoneSaving$ = command(({ set }, value: boolean) => {
  set(internalTimezoneSaving$, value);
});
