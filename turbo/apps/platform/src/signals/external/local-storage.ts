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

/**
 * Read a value from localStorage by dynamic key.
 */
export function readLocalStorage(key: string): string | null {
  return localStorage.getItem(key);
}

/**
 * Write or remove a value in localStorage by dynamic key.
 * Passing null removes the item.
 *
 * Note: This command does NOT trigger reactive updates for signals created via
 * `localStorageSignals(key).get$`. The two APIs are not interoperable for the
 * same key — use `localStorageSignals(key).set$` if reactive propagation is needed.
 */
export const writeLocalStorage$ = command(
  ({ set }, { key, value }: { key: string; value: string | null }) => {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      set(registeredLocalStorageKeys$, (x) => {
        if (x?.has(key)) {
          return x;
        }
        x = new Set(x ?? []);
        x.add(key);
        return x;
      });
      localStorage.setItem(key, value);
    }
  },
);

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

  return Object.freeze({ get$, set$, clear$ });
}
