import { command, computed, state } from "ccstate";

export type PreferencesTab = "notifications" | "timezone";

const internalActiveTab$ = state<PreferencesTab>("notifications");

export const activeTab$ = computed((get) => get(internalActiveTab$));

export const setActiveTab$ = command(({ set }, tab: PreferencesTab) => {
  set(internalActiveTab$, tab);
});
