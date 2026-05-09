import { computed } from "ccstate";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { orgModelProviders$ } from "../external/org-model-providers.ts";

interface ComposerModelProviders {
  /** Org-scoped providers available to provider-first composer pickers. */
  providers: ModelProviderResponse[];
}

/**
 * Provider stream consumed by the chat composer model picker.
 */
export const composerModelProviders$ = computed(
  async (get): Promise<ComposerModelProviders> => {
    const org = await get(orgModelProviders$);
    return { providers: org.modelProviders };
  },
);
