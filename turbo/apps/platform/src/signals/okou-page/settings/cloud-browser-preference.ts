import { command, computed, state } from "ccstate";

import { cloudBrowserEnabledByDefault$ } from "../../cloud-browser-preference.ts";
import { pageSignal$ } from "../../page-signal.ts";
import { updateUserPreference$ } from "./user-preferences.ts";

const internalCloudBrowserSubmission$ = state<{
  readonly enabled: boolean;
  readonly signal: AbortSignal;
} | null>(null);

export const submittedCloudBrowserEnabledByDefault$ = computed((get) => {
  const submission = get(internalCloudBrowserSubmission$);
  return submission?.signal === get(pageSignal$) ? submission.enabled : null;
});

export const updateCloudBrowserEnabledByDefault$ = command(
  async (
    { get, set },
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    set(internalCloudBrowserSubmission$, { enabled, signal });
    await set(
      updateUserPreference$,
      { cloudBrowserEnabledByDefault: enabled },
      signal,
    );
    signal.throwIfAborted();
    await get(cloudBrowserEnabledByDefault$);
    signal.throwIfAborted();
  },
);
