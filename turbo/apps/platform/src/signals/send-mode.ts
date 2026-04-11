import { computed } from "ccstate";
import type { SendMode } from "@vm0/core";
import { userPreferences$ } from "./zero-page/settings/user-preferences.ts";

/** Current send mode preference, sourced from user preferences API. */
export const sendMode$ = computed(async (get): Promise<SendMode> => {
  const prefs = await get(userPreferences$);
  return prefs.sendMode ?? "enter";
});
