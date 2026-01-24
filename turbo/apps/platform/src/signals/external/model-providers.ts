import { computed } from "ccstate";
import { fetch$ } from "../fetch";
import type { ModelProviderListResponse } from "@vm0/core";

export const modelProviders$ = computed(async (get) => {
  const fetchFn = get(fetch$);
  const resp = fetchFn("/api/model-providers");
  return (await resp).json() as Promise<ModelProviderListResponse>;
});
