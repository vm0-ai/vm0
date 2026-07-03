import { command, computed, state } from "ccstate";
import { searchParams$, replaceSearchParams$ } from "../route.ts";
import { startQueuePolling$ } from "./queue-signals.ts";
import { detach, Reason, resetSignal } from "../utils.ts";

const internalQueueDrawerOpen$ = state(false);
const resetQueuePollingSignal$ = resetSignal();

export const CONCURRENCY_QUANTITY_MIN = 1;
export const CONCURRENCY_QUANTITY_MAX = 1000;

const internalConcurrencyQuantity$ = state(CONCURRENCY_QUANTITY_MIN);

export const queueDrawerOpen$ = computed((get) => {
  return get(internalQueueDrawerOpen$);
});

export const concurrencyQuantity$ = computed((get) => {
  return get(internalConcurrencyQuantity$);
});

function clampConcurrencyQuantity(quantity: number): number {
  return Math.min(
    CONCURRENCY_QUANTITY_MAX,
    Math.max(CONCURRENCY_QUANTITY_MIN, quantity),
  );
}

export const setConcurrencyQuantity$ = command(({ set }, quantity: number) => {
  set(internalConcurrencyQuantity$, clampConcurrencyQuantity(quantity));
});

export const resetConcurrencyQuantity$ = command(({ set }) => {
  set(internalConcurrencyQuantity$, CONCURRENCY_QUANTITY_MIN);
});

export const setQueueDrawerOpen$ = command(
  ({ get, set }, open: boolean, parentSignal: AbortSignal) => {
    set(internalQueueDrawerOpen$, open);

    const params = get(searchParams$);
    const next = new URLSearchParams(params);

    if (open) {
      if (!next.has("queue")) {
        next.set("queue", "1");
        set(replaceSearchParams$, next);
      }

      const signal = set(resetQueuePollingSignal$, parentSignal);

      // confirmed by ethan@vm0.ai
      // eslint-disable-next-line ccstate/no-detach-in-signals -- polling is a long-running background task, fire-and-forget by design
      detach(set(startQueuePolling$, signal), Reason.Entrance);
    } else {
      if (next.has("queue")) {
        next.delete("queue");
        set(replaceSearchParams$, next);
      }
      set(resetQueuePollingSignal$);
    }
  },
);

export const openQueueDrawer$ = command(({ set }, signal: AbortSignal) => {
  set(setQueueDrawerOpen$, true, signal);
});
