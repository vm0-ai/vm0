import { command, computed, state } from "ccstate";

import type { ModelProviderSelection } from "../../../views/okou-page/components/model-provider-picker.tsx";
import {
  reloadUserModelPreference$,
  updateUserModelPreference$,
  userModelPreference$,
} from "../../external/user-model-preference.ts";
import { pageSignal$ } from "../../page-signal.ts";

interface DefaultModelSubmission {
  readonly selection: ModelProviderSelection | null;
  readonly signal: AbortSignal;
}

const internalDefaultModelSubmission$ = state<DefaultModelSubmission | null>(
  null,
);

export const defaultModelSubmission$ = computed((get) => {
  const submission = get(internalDefaultModelSubmission$);
  return submission?.signal === get(pageSignal$)
    ? { selection: submission.selection }
    : null;
});

export const updateDefaultModelPreference$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    set(internalDefaultModelSubmission$, { selection, signal });
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
