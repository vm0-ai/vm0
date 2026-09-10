import { command, computed, state } from "ccstate";

const innerPageSignal$ = state<AbortSignal | undefined>(undefined);
const innerPageVersion$ = state(0);

export const setPageSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerPageSignal$, signal);
  set(innerPageVersion$, (version) => {
    return version + 1;
  });
});

/** A signal-free invalidation key for values scoped to one page setup. */
export const pageVersion$ = computed((get) => {
  return get(innerPageVersion$);
});

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
export const pageSignal$ = computed((get) => {
  // This part is essential. We mainly need to control the downstream "get" of this method so that it cannot retrieve a Signal.
  // eslint-disable-next-line ccstate/no-get-signal
  const signal = get(innerPageSignal$);
  if (!signal) {
    throw new Error("page signal not set");
  }
  return signal;
});
