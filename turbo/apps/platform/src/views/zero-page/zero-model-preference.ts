import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
import { MODEL_PROVIDER_TYPES } from "@vm0/core";
import { orgModelProviders$ } from "../../signals/external/org-model-providers.ts";

function readModelPreference(key: string): string {
  if (typeof window === "undefined") {
    return "default";
  }
  return localStorage.getItem(key) ?? "default";
}

function writeModelPreference(key: string, value: string) {
  if (value === "default") {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
}

/**
 * Hook for managing model selection state with agent-change reset.
 * Returns the current selected model, a setter, and a handler to persist on send.
 */
export function useModelSelection(agentName: string) {
  const modelProvidersLoadable = useLastLoadable(orgModelProviders$);
  const configuredProviders =
    modelProvidersLoadable.state === "hasData"
      ? modelProvidersLoadable.data.modelProviders
      : [];
  const modelOptions = [
    { value: "default", label: "Default" },
    ...configuredProviders.map((p) => ({
      value: p.type,
      label: MODEL_PROVIDER_TYPES[p.type].label,
    })),
  ];

  const modelStorageKey = `zero.modelProvider.${agentName}`;
  const selectedModel$ = useCCState(readModelPreference(modelStorageKey));
  const selectedModel = useGet(selectedModel$);
  const setSelectedModel = useSet(selectedModel$);

  // Reset model selection when agent changes
  const prevAgentName$ = useCCState(agentName);
  const prevAgentName = useGet(prevAgentName$);
  const setPrevAgentName = useSet(prevAgentName$);
  if (agentName !== prevAgentName) {
    queueMicrotask(() => {
      setPrevAgentName(agentName);
      setSelectedModel(readModelPreference(`zero.modelProvider.${agentName}`));
    });
  }

  const persistSelection = () => {
    writeModelPreference(modelStorageKey, selectedModel);
  };

  return {
    modelOptions,
    selectedModel,
    setSelectedModel,
    persistSelection,
  } as const;
}
