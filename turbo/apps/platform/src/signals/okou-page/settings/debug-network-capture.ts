import { command, computed } from "ccstate";

import { updateUserPreference$, userPreferences$ } from "./user-preferences.ts";

export const captureNetworkBodiesRemaining$ = computed(async (get) => {
  const preferences = await get(userPreferences$);
  return preferences.captureNetworkBodiesRemaining;
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
