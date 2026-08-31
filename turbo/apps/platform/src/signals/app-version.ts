import { command, computed, state } from "ccstate";

const internalAppVersion$ = state<string | undefined>(undefined);

export const appVersion$ = computed((get): string => {
  const version = get(internalAppVersion$);
  if (version === undefined) {
    throw new Error("App version was not initialized during bootstrap");
  }
  return version;
});

export const initializeAppVersion$ = command(
  ({ get, set }, version: string): void => {
    if (version.length === 0) {
      throw new Error("App version must not be empty");
    }
    const currentVersion = get(internalAppVersion$);
    if (currentVersion === undefined) {
      set(internalAppVersion$, version);
      return;
    }
    if (currentVersion !== version) {
      throw new Error(
        `App version was already initialized as ${currentVersion}`,
      );
    }
  },
);
