import { command, computed, state } from "ccstate";

const registeredLocalStorageKeys$ = state<Set<string> | null>(null);

export const resetLocalStorageForTest$ = command(({ set, get }) => {
  const keys = get(registeredLocalStorageKeys$);
  if (!keys) {
    return;
  }

  for (const key of keys) {
    localStorage.removeItem(key);
  }

  set(registeredLocalStorageKeys$, null);
});

export function localStorageSignals(key: string) {
  const reload$ = state(0);

  const get$ = computed((get) => {
    get(reload$);

    return localStorage.getItem(key);
  });

  const set$ = command(({ set }, value: string) => {
    set(registeredLocalStorageKeys$, (x) => {
      if (x?.has(key)) {
        return x;
      }

      x = new Set(x ?? []);
      x.add(key);
      return x;
    });
    localStorage.setItem(key, value);
    set(reload$, (prev) => prev + 1);
  });

  const clear$ = command(({ set }) => {
    localStorage.removeItem(key);
    set(reload$, (prev) => prev + 1);
  });

  return Object.freeze({ get$, set$, clear$ });
}
