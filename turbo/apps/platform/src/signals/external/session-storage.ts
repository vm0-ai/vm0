import { state } from "ccstate";
import {
  createResetStorageForTest,
  createStorageSignals,
} from "./storage-signals.ts";

const registeredSessionStorageKeys$ = state<Set<string> | null>(null);

export const resetSessionStorageForTest$ = createResetStorageForTest(() => {
  return sessionStorage;
}, registeredSessionStorageKeys$);

export function sessionStorageSignals(key: string) {
  return createStorageSignals(
    () => {
      return sessionStorage;
    },
    registeredSessionStorageKeys$,
    key,
  );
}
