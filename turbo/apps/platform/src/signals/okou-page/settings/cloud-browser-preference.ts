import { command, computed, state } from "ccstate";

import { cloudBrowserEnabledByDefault$ } from "../../cloud-browser-preference.ts";
import { updateUserPreference$ } from "./user-preferences.ts";

const internalPendingCloudBrowserEnabledByDefault$ = state<boolean | null>(
  null,
);

export const pendingCloudBrowserEnabledByDefault$ = computed((get) => {
  return get(internalPendingCloudBrowserEnabledByDefault$);
});

export const updateCloudBrowserEnabledByDefault$ = command(
  async (
    { get, set },
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    set(internalPendingCloudBrowserEnabledByDefault$, enabled);
    await set(
      updateUserPreference$,
      { cloudBrowserEnabledByDefault: enabled },
      signal,
    ).finally(() => {
      set(internalPendingCloudBrowserEnabledByDefault$, null);
    });
    signal.throwIfAborted();
    await get(cloudBrowserEnabledByDefault$);
    signal.throwIfAborted();
  },
);
