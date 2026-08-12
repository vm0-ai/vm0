import { state } from "ccstate";
import {
  createResetStorageForTest,
  createStorageSignals,
} from "./storage-signals.ts";

const registeredLocalStorageKeys$ = state<Set<string> | null>(null);

export const resetLocalStorageForTest$ = createResetStorageForTest(() => {
  return localStorage;
}, registeredLocalStorageKeys$);

export function localStorageSignals(key: string) {
  return createStorageSignals(
    () => {
      return localStorage;
    },
    registeredLocalStorageKeys$,
    key,
  );
}
