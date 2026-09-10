import { command, computed, state } from "ccstate";

const innerRootSignal$ = state<AbortSignal | undefined>(undefined);

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
export const rootSignal$ = computed((get) => {
  // eslint-disable-next-line ccstate/no-get-signal
  const signal = get(innerRootSignal$);
  if (!signal) {
    throw new Error("No root signal");
  }
  return signal;
});

export const setRootSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerRootSignal$, signal);
});
