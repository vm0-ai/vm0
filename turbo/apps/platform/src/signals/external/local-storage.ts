import { command, computed, state } from "ccstate";

const registeredLocalStorageKeys$ = state<Set<string> | null>(null);

export const resetLocalStorageForTest$ = command(({ set, get }) => {
  const keys = get(registeredLocalStorageKeys$);
  for (const key of keys ?? []) {
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
    set(reload$, (prev) => {
      return prev + 1;
    });
  });

  const clear$ = command(({ set }) => {
    localStorage.removeItem(key);
    set(reload$, (prev) => {
      return prev + 1;
    });
  });

  const updateRaw = (update: (value: string | null) => string | null) => {
    const next = update(localStorage.getItem(key));
    if (next === null) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, next);
  };

  return Object.freeze({ get$, set$, clear$, updateRaw });
}
