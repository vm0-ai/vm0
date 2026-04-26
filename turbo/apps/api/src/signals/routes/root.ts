import { computed } from "ccstate";

import { builtInModels$ } from "../services/built-in-models";

export const apiRoot$ = computed(async (get) => {
  const models = await get(builtInModels$);
  return { message: "Hello Hono!", models };
});
