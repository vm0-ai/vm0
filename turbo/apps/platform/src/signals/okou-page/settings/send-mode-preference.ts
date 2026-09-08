import { command, computed, state } from "ccstate";
import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";

import { sendMode$ } from "../../send-mode.ts";
import { pageSignal$ } from "../../page-signal.ts";
import { updateUserPreference$ } from "./user-preferences.ts";

const internalSendModeSubmission$ = state<{
  readonly value: SendMode;
  readonly signal: AbortSignal;
} | null>(null);

export const submittedSendMode$ = computed((get) => {
  const submission = get(internalSendModeSubmission$);
  return submission?.signal === get(pageSignal$) ? submission.value : null;
});

/**
 * Update send mode preference. After saving, await the refetched value so the
 * UI never flashes back to the old value before the signal updates.
 */
export const updateSendMode$ = command(
  async ({ get, set }, value: SendMode, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(internalSendModeSubmission$, { value, signal });
    await set(updateUserPreference$, { sendMode: value }, signal);
    signal.throwIfAborted();
    await get(sendMode$);
    signal.throwIfAborted();
  },
);
