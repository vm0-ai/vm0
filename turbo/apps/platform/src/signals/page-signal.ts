import { command, computed, state } from "ccstate";

const innerPageSignal$ = state<AbortSignal | undefined>(undefined);

export const setPageSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerPageSignal$, signal);
});

export const pageSignal$ = computed((get) => {
  // This part is essential. We mainly need to control the downstream "get" of this method so that it cannot retrieve a Signal.
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line ccstate/no-get-signal
  const signal = get(innerPageSignal$);
  if (!signal) {
    throw new Error("page signal not set");
  }
  return signal;
});
