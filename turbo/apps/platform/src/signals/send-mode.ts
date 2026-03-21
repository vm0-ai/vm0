import { computed, state, command } from "ccstate";
import type { SendMode } from "@vm0/core";
import { notificationPreferences$ } from "./zero-page/settings/notification-settings.ts";

/** Current send mode preference, sourced from user preferences API. */
export const sendMode$ = computed(async (get): Promise<SendMode> => {
  const prefs = await get(notificationPreferences$);
  return prefs.sendMode ?? "enter";
});

/** Whether an IME composition session is active in the chat composer. */
const internalComposing$ = state(false);
export const composing$ = computed((get) => get(internalComposing$));

/** Mark IME composition as started. */
export const compositionStart$ = command(({ set }) => {
  set(internalComposing$, true);
});

/** Mark IME composition as ended. */
export const compositionEnd$ = command(({ set }) => {
  set(internalComposing$, false);
});
