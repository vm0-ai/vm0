import { createStore, type Computed } from "ccstate";
import type { Handler } from "hono";

import { initHono$ } from "./hono";
import { setRootSignal$ } from "./root";

export function honoComputed<T>(
  result$: Computed<T>,
  signal: AbortSignal,
): Handler {
  return async (context) => {
    const store = createStore();
    store.set(setRootSignal$, signal);
    store.set(initHono$, context);

    const data = await store.get(result$);
    return context.json(data);
  };
}
