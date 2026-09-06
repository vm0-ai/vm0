import { command, computed, state } from "ccstate";

import type { ModelProviderSelection } from "../../../views/okou-page/components/model-provider-picker.tsx";
import {
  reloadUserModelPreference$,
  updateUserModelPreference$,
  userModelPreference$,
} from "../../external/user-model-preference.ts";

interface PendingDefaultModelSelection {
  readonly selection: ModelProviderSelection | null;
}

const internalPendingDefaultModelSelection$ =
  state<PendingDefaultModelSelection | null>(null);

export const pendingDefaultModelSelection$ = computed((get) => {
  return get(internalPendingDefaultModelSelection$);
});

const persistDefaultModelPreference$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      updateUserModelPreference$,
      {
        selectedModel: selection?.selectedModel ?? null,
        serviceTier: selection?.codexServiceTier === "fast" ? "priority" : null,
      },
      signal,
    );
    signal.throwIfAborted();
    set(reloadUserModelPreference$);
    await get(userModelPreference$);
    signal.throwIfAborted();
  },
);

export const updateDefaultModelPreference$ = command(
  (
    { set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    set(internalPendingDefaultModelSelection$, { selection });
    return set(persistDefaultModelPreference$, selection, signal).finally(
      () => {
        set(internalPendingDefaultModelSelection$, null);
      },
    );
  },
);
