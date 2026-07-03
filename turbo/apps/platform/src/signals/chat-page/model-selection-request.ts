import type {
  ChatRunOptionsRequest,
  CodexServiceTier,
  ModelSelectionRequest,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

export function modelSelectionRequestFromSelection(
  value: ModelProviderSelection | null,
): ModelSelectionRequest | null {
  if (!value) {
    return null;
  }
  return {
    modelProviderId: value.modelProviderId,
    selectedModel: value.selectedModel,
  };
}

export function runOptionsFromModelProviderSelection(
  value: ModelProviderSelection | null,
  codexFastModeEnabled: boolean,
): ChatRunOptionsRequest | undefined {
  return codexFastModeEnabled && value?.codexServiceTier === "fast"
    ? { codexServiceTier: "fast" }
    : undefined;
}

export function threadCodexServiceTierFromSelection(
  value: ModelProviderSelection | null,
): CodexServiceTier | null {
  return value?.codexServiceTier === "fast" ? "fast" : null;
}
