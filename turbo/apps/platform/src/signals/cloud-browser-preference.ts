import { computed } from "ccstate";

import { userPreferences$ } from "./okou-page/settings/user-preferences.ts";

/** Whether Cloud browser should be enabled for untouched new-chat drafts. */
export const cloudBrowserEnabledByDefault$ = computed(
  async (get): Promise<boolean> => {
    const preferences = await get(userPreferences$);
    return preferences.cloudBrowserEnabledByDefault;
  },
);
