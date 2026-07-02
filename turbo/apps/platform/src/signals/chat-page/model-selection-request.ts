import type {
  ChatRunOptionsRequest,
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
): ChatRunOptionsRequest | undefined {
  return value?.codexServiceTier === "fast"
    ? { codexServiceTier: "fast" }
    : undefined;
}
