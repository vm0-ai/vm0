import { command, computed, state } from "ccstate";

const innerPageSignal$ = state<AbortSignal | undefined>(undefined);

export const setPageSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerPageSignal$, signal);
});

export const pageSignal$ = computed((get) => {
  // here is an exception case because we don't want use pass pageSignal$ in react component props
  // eslint-disable-next-line ccstate/no-get-signal
  const signal = get(innerPageSignal$);
  if (!signal) {
    throw new Error("page signal not set");
  }
  return signal;
});
