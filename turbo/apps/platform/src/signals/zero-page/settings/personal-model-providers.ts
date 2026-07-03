import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  deletePersonalModelProvider$,
  personalModelProviders$,
} from "../../external/personal-model-providers.ts";

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalPersonalActionPromise$ = state<Promise<unknown> | null>(null);

export const personalActionPromise$ = computed((get) => {
  return get(internalPersonalActionPromise$);
});

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

export const personalConfiguredProviders$ = computed(async (get) => {
  const { modelProviders } = await get(personalModelProviders$);
  return [...modelProviders].sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
});

export const disconnectPersonalOAuthCredential$ = command(
  async ({ set }, providerType: ModelProviderType, signal: AbortSignal) => {
    const providerLabel =
      MODEL_PROVIDER_TYPES[providerType]?.label ?? providerType;

    const promise = (async () => {
      await set(deletePersonalModelProvider$, providerType, signal);
      signal.throwIfAborted();
      toast.success(`${providerLabel} disconnected`);
    })();

    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);
