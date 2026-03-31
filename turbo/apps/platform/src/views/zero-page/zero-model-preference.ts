import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { orgModelProviders$ } from "../../signals/external/org-model-providers.ts";
import {
  selectedModel$,
  setSelectedModel$,
  persistModelPreference$,
} from "../../signals/zero-page/zero-model-preference.ts";
import { getUILabel } from "./components/settings/provider-ui-config.ts";

/**
 * Hook for managing model selection state.
 * State lives in the signals layer; the view only reads/writes.
 * Agent-change reset is handled by syncModelPreference$ in each route's setup function.
 */
export function useModelSelection() {
  const modelProvidersLoadable = useLastLoadable(orgModelProviders$);
  const configuredProviders =
    modelProvidersLoadable.state === "hasData"
      ? (modelProvidersLoadable.data.modelProviders ?? [])
      : [];
  const modelOptions = configuredProviders.map((p) => {
    return {
      value: p.type,
      label: getUILabel(p.type),
    };
  });

  const defaultProvider = configuredProviders.find((p) => {
    return p.isDefault;
  });
  const rawSelected = useGet(selectedModel$);
  const effectiveSelected =
    rawSelected === "default" && defaultProvider
      ? defaultProvider.type
      : rawSelected;

  const setSelectedModel = useSet(setSelectedModel$);
  const persistSelection = useSet(persistModelPreference$);

  return {
    modelOptions,
    selectedModel: effectiveSelected,
    setSelectedModel,
    persistSelection,
  } as const;
}
