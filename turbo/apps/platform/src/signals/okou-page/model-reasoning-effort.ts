import {
  defaultModelReasoningEffort,
  getModelReasoningEfforts,
  modelReasoningEffort,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

/** Native chat choices only; Pi effort is owned by a separate rollout. */
export function availableChatReasoningEfforts(
  model: string | null | undefined,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): readonly ReasoningEffort[] {
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

/** Resolve the value this UI can execute without mutating the saved preference. */
export function effectiveChatReasoningEffort(
  selection: ModelProviderSelection | null | undefined,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): ReasoningEffort | undefined {
  if (!selection) {
    return undefined;
  }
  const available = availableChatReasoningEfforts(
    selection.selectedModel,
    switches,
  );
  const preferred = modelReasoningEffort(
    selection.selectedModel,
    selection.modelSettings,
  );
  if (preferred && available.includes(preferred)) {
    return preferred;
  }
  const defaultEffort = defaultModelReasoningEffort(selection.selectedModel);
  return defaultEffort && available.includes(defaultEffort)
    ? defaultEffort
    : undefined;
}

/** Preserve the map across model and Fast changes; never copy one model's effort. */
export function withChatModelSettings(
  selection: ModelProviderSelection | null,
  previous: ModelProviderSelection | null,
) {
  if (!selection) {
    return selection;
  }
  return {
    ...selection,
    modelSettings: selection.modelSettings ?? previous?.modelSettings ?? {},
  };
}
