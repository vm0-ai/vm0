import { computed } from "ccstate";
import { orgModelProviders$ } from "../../external/org-model-providers.ts";

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

export const orgConfiguredProviders$ = computed(async (get) => {
  const { modelProviders } = await get(orgModelProviders$);
  return [...modelProviders].sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
});
