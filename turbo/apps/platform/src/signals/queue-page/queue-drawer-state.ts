import { command, computed, state } from "ccstate";
import { searchParams$, replaceSearchParams$ } from "../route.ts";

const internalQueueDrawerOpen$ = state(false);

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
  if (!Number.isInteger(quantity)) {
    return;
  }
  set(internalConcurrencyQuantity$, clampConcurrencyQuantity(quantity));
});

export const setQueueDrawerOpen$ = command(({ get, set }, open: boolean) => {
  if (open) {
    set(internalConcurrencyQuantity$, CONCURRENCY_QUANTITY_MIN);
  }
  set(internalQueueDrawerOpen$, open);

  const params = get(searchParams$);
  const next = new URLSearchParams(params);

  if (open) {
    if (!next.has("queue")) {
      next.set("queue", "1");
      set(replaceSearchParams$, next);
    }
  } else if (next.has("queue")) {
    next.delete("queue");
    set(replaceSearchParams$, next);
  }
});

export const openQueueDrawer$ = command(({ set }) => {
  set(setQueueDrawerOpen$, true);
});
