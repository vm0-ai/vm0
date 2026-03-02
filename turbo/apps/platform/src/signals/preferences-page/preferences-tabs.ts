import { command, computed, state } from "ccstate";

export type PreferencesTab = "notifications" | "timezone";

const internalActiveTab$ = state<PreferencesTab>("notifications");

export const activeTab$ = computed((get) => get(internalActiveTab$));

export const setActiveTab$ = command(({ set }, tab: PreferencesTab) => {
  set(internalActiveTab$, tab);
});

// Timezone preference (used in TimezoneSettings)
const internalTimezone$ = state<string>("UTC");
export const timezone$ = computed((get) => get(internalTimezone$));
export const setTimezone$ = command(({ set }, value: string) => {
  set(internalTimezone$, value);
});

// Notification toggles (used in NotificationSettings)
const internalEmailEnabled$ = state(false);
const internalSlackEnabled$ = state(false);
export const emailNotificationsEnabled$ = computed((get) =>
  get(internalEmailEnabled$),
);
export const slackNotificationsEnabled$ = computed((get) =>
  get(internalSlackEnabled$),
);
export const setEmailNotificationsEnabled$ = command(
  ({ set }, value: boolean) => {
    set(internalEmailEnabled$, value);
  },
);
export const setSlackNotificationsEnabled$ = command(
  ({ set }, value: boolean) => {
    set(internalSlackEnabled$, value);
  },
);
