import { command, computed } from "ccstate";
import { localStorageSignals } from "../external/local-storage.ts";

const { get$, set$ } = localStorageSignals("audioOutput.autoRead");

export const autoReadEnabled$ = computed((get) => {
  return get(get$) === "true";
});

export const toggleAutoRead$ = command(({ get, set }) => {
  const current = get(get$) === "true";
  set(set$, current ? "false" : "true");
});
