import { command, computed, state } from "ccstate";

const sharedDatabaseModeState$ = state<boolean | null>(null);

export const selectSharedDatabaseMode$ = command(
  ({ get, set }, enabled: boolean): void => {
    if (get(sharedDatabaseModeState$) === null) {
      set(sharedDatabaseModeState$, enabled);
    }
  },
);

export const sharedDatabaseModeEnabled$ = computed((get): boolean => {
  return get(sharedDatabaseModeState$) ?? false;
});
