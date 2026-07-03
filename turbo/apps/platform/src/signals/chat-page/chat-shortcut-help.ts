import { command, computed, state } from "ccstate";

const internalShortcutHelpOpen$ = state(false);

export const chatShortcutHelpOpen$ = computed((get) => {
  return get(internalShortcutHelpOpen$);
});

export const setChatShortcutHelpOpen$ = command(({ set }, open: boolean) => {
  set(internalShortcutHelpOpen$, open);
});
