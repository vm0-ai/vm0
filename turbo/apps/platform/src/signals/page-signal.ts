import { command, computed, state } from "ccstate";

interface SignalHolder {
  readonly signal: AbortSignal;
}

const innerPageSignal$ = state<SignalHolder | undefined>(undefined);

export const setPageSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerPageSignal$, { signal });
});

export const maybePageSignal$ = computed((get) => {
  return get(innerPageSignal$)?.signal;
});

export const pageSignal$ = computed((get) => {
  const signal = get(maybePageSignal$);
  if (!signal) {
    throw new Error("page signal not set");
  }
  return signal;
});
