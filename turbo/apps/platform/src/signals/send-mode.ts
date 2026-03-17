import { computed } from "ccstate";
import type { SendMode } from "@vm0/core";
import { notificationPreferences$ } from "./zero-page/settings/notification-settings.ts";

/** Current send mode preference, sourced from user preferences API. */
export const sendMode$ = computed(async (get): Promise<SendMode> => {
  const prefs = await get(notificationPreferences$);
  return prefs.sendMode ?? "enter";
});
