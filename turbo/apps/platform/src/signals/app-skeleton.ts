import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";

const internalVisible$ = state(true);

export const appSkeletonVisible$ = computed((get) => {
  return get(internalVisible$);
});

export const hideAppSkeleton$ = command(
  async ({ set }, signal: AbortSignal) => {
    await delay(0, { signal });
    set(internalVisible$, false);
  },
);
