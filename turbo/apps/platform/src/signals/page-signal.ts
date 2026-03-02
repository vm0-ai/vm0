import { command, computed, state } from "ccstate";

interface SignalHolder {
  readonly signal: AbortSignal;
}

const innerPageSignal$ = state<SignalHolder | undefined>(undefined);

export const setPageSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerPageSignal$, { signal });
});

export const pageSignal$ = computed((get) => {
  const holder = get(innerPageSignal$);
  if (!holder) {
    throw new Error("page signal not set");
  }
  return holder.signal;
});
