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

// Holder variant for infrastructure helpers (e.g. onDomCallback in utils.ts)
// that need to read the signal without tripping the `no-get-signal` rule,
// which bans `get(Computed<AbortSignal>)` in favour of parameter passing.
export const pageSignalHolder$ = computed<SignalHolder>((get) => {
  const holder = get(innerPageSignal$);
  if (!holder) {
    throw new Error("page signal not set");
  }
  return holder;
});
