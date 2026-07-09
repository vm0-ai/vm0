import type {
  ChatRunOptionsRequest,
  CodexServiceTier,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

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
