import { command, computed, state } from "ccstate";

const internalUnifiedSettingsOpen$ = state(false);

export const unifiedSettingsOpen$ = computed((get) => {
  return get(internalUnifiedSettingsOpen$);
});

export const setUnifiedSettingsOpen$ = command(({ set }, open: boolean) => {
  set(internalUnifiedSettingsOpen$, open);
});
