import {
  compatibleReasoningEffort,
  getModelReasoningEfforts,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

/** Native chat choices only; Pi effort is owned by a separate rollout. */
export function availableChatReasoningEfforts(
  model: string | null | undefined,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
) {
  if (
    !switches[FeatureSwitchKey.ChatReasoningEffort] ||
    (switches[FeatureSwitchKey.PiLoop] && !model?.startsWith("claude-"))
  ) {
    return [];
  }
  return getModelReasoningEfforts(model).filter((effort) => {
    // The native flag alone does not establish Ultracode mode availability.
    return effort !== "ultracode";
  });
}

export function withCompatibleChatReasoningEffort(
  selection: ModelProviderSelection | null,
  previous: ModelProviderSelection | null,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
) {
  if (
    !selection ||
    selection.reasoningEffort !== undefined ||
    previous?.reasoningEffort === undefined
  ) {
    return selection;
  }
  return {
    ...selection,
    reasoningEffort:
      selection.selectedModel !== previous.selectedModel &&
      availableChatReasoningEfforts(selection.selectedModel, switches)
        .length === 0
        ? null
        : compatibleReasoningEffort(
            selection.selectedModel,
            previous.reasoningEffort,
          ),
  };
}
