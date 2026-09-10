import {
  compatibleReasoningEffort,
  getModelReasoningEfforts,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { normalizeBuiltInModelId } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

/** Match Okou's native launch defaults when the thread has no override. */
export function defaultChatReasoningEffort(
  model: string,
): ReasoningEffort | null {
  const bareModel = model.startsWith("openai/")
    ? model.slice("openai/".length)
    : model;
  switch (normalizeBuiltInModelId(bareModel)) {
    case "gpt-6-astra":
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
    case "claude-fable-5-1": {
      return "max";
    }
    case "gpt-5.5": {
      return "xhigh";
    }
    case "claude-opus-5":
    case "claude-opus-4-8":
    case "claude-sonnet-5":
    case "claude-sonnet-4-6": {
      return "high";
    }
    default: {
      return null;
    }
  }
}

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
