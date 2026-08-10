import type {
  ChatRunOptionsRequest,
  ChatThreadServiceTier,
  CodexServiceTier,
  UserMessageDocument,
  UserMessageInputDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

/**
 * Mirror the server-owned run-model annotation in the client projection. The
 * separate model and run-options request fields remain authoritative; the
 * server replaces this annotation with the selection resolved for the run.
 */
export function withSelectedModelAnnotation(
  document: UserMessageInputDocument,
  selectedModel: string | null | undefined,
  serviceTier?: ChatThreadServiceTier,
): UserMessageDocument {
  if (selectedModel === null || selectedModel === undefined) {
    return document;
  }
  return {
    version: 1,
    parts: [
      ...document.parts,
      {
        type: "model",
        selectedModel,
        ...(serviceTier === undefined ? {} : { serviceTier }),
      },
    ],
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
