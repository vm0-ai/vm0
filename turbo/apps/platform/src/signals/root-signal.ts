import { command, computed, state } from "ccstate";

const innerRootSignal$ = state<AbortSignal | undefined>(undefined);

export const rootSignal$ = computed((get) => {
  const signal = get(innerRootSignal$);
  if (!signal) {
    throw new Error("No root signal");
  }
  return signal;
});

export const setRootSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerRootSignal$, signal);
});
