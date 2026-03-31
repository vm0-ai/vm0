import { computed, state, command } from "ccstate";
import type { SendMode } from "@vm0/core";
import { userPreferences$ } from "./zero-page/settings/user-preferences.ts";

/** Current send mode preference, sourced from user preferences API. */
export const sendMode$ = computed(async (get): Promise<SendMode> => {
  const prefs = await get(userPreferences$);
  return prefs.sendMode ?? "enter";
});

/** Whether an IME composition session is active in the chat composer. */
const internalComposing$ = state(false);
export const composing$ = computed((get) => {
  return get(internalComposing$);
});

/** Mark IME composition as started. */
export const compositionStart$ = command(({ set }) => {
  set(internalComposing$, true);
});

/** Mark IME composition as ended. */
export const compositionEnd$ = command(({ set }) => {
  set(internalComposing$, false);
});
