import { command, computed, state } from "ccstate";

const innerRootSignal$ = state<AbortSignal | undefined>(undefined);

export const rootSignal$ = computed((get) => {
  // here is an exception case because we don't want use pass rootSignal$ in react component props
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
