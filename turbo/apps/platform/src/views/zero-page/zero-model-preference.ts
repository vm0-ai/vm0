import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { MODEL_PROVIDER_TYPES } from "@vm0/core";
import { orgModelProviders$ } from "../../signals/external/org-model-providers.ts";
import {
  selectedModel$,
  setSelectedModel$,
  persistModelPreference$,
} from "../../signals/zero-page/zero-model-preference.ts";

/**
 * Hook for managing model selection state.
 * State lives in the signals layer; the view only reads/writes.
 * Agent-change reset is handled by syncModelPreference$ in setupZeroPage$.
 */
export function useModelSelection() {
  const modelProvidersLoadable = useLastLoadable(orgModelProviders$);
  const configuredProviders =
    modelProvidersLoadable.state === "hasData"
      ? (modelProvidersLoadable.data.modelProviders ?? [])
      : [];
  const modelOptions = [
    { value: "default", label: "Default" },
    ...configuredProviders.map((p) => ({
      value: p.type,
      label: MODEL_PROVIDER_TYPES[p.type].label,
    })),
  ];

  const selectedModel = useGet(selectedModel$);
  const setSelectedModel = useSet(setSelectedModel$);
  const persistSelection = useSet(persistModelPreference$);

  return {
    modelOptions,
    selectedModel,
    setSelectedModel,
    persistSelection,
  } as const;
}
