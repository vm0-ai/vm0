import { createStore, type Computed } from "ccstate";
import type { Handler } from "hono";

import { initHono$ } from "./hono";

export function honoComputed<T>(result$: Computed<T>): Handler {
  return async (context) => {
    const store = createStore();
    store.set(initHono$, context);

    const data = await store.get(result$);
    return context.json(data);
  };
}
