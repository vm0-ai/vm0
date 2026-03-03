import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import type {
  UserPreferencesResponse,
  UpdateUserPreferencesRequest,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";

// ---------------------------------------------------------------------------
// Reload trigger
// ---------------------------------------------------------------------------

const internalReloadPreferences$ = state(0);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export const notificationPreferences$ = computed(async (get) => {
  get(internalReloadPreferences$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/user/preferences");
  const data = (await resp.json()) as UserPreferencesResponse;
  return data;
});

// ---------------------------------------------------------------------------
// Update command
// ---------------------------------------------------------------------------

export const updateNotificationPreference$ = command(
  async ({ get, set }, update: UpdateUserPreferencesRequest) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });

    if (!response.ok) {
      toast.error("Failed to update notification preference");
      return;
    }

    set(internalReloadPreferences$, (x) => x + 1);
  },
);
