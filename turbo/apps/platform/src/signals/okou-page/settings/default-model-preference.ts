import { command } from "ccstate";

import type { ModelProviderSelection } from "../../../views/okou-page/components/model-provider-picker.tsx";
import {
  reloadUserModelPreference$,
  updateUserModelPreference$,
  userModelPreference$,
} from "../../external/user-model-preference.ts";

export const updateDefaultModelPreference$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
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
