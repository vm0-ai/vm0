import { command, computed, state } from "ccstate";

import type { ModelProviderSelection } from "../../../views/okou-page/components/model-provider-picker.tsx";
import { updateUserModelPreference$ } from "../../external/user-model-preference.ts";

interface PendingDefaultModelSelection {
  readonly selection: ModelProviderSelection | null;
}

const internalPendingDefaultModelSelection$ =
  state<PendingDefaultModelSelection | null>(null);

export const pendingDefaultModelSelection$ = computed((get) => {
  return get(internalPendingDefaultModelSelection$);
});

export const updateDefaultModelPreference$ = command(
  async (
    { set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    set(internalPendingDefaultModelSelection$, { selection });
    await set(
      updateUserModelPreference$,
      {
        selectedModel: selection?.selectedModel ?? null,
        serviceTier: selection?.codexServiceTier === "fast" ? "priority" : null,
      },
      signal,
    ).finally(() => {
      set(internalPendingDefaultModelSelection$, null);
    });
    signal.throwIfAborted();
  },
);
