import {
  defaultModelReasoningEffort,
  isModelReasoningEffortSupported,
  modelReasoningEffort,
  withModelReasoningEffort,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { isSupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { badRequestMessage } from "../../lib/error";

/** Keep saved preferences dormant while rollout is disabled. */
export function resolveChatReasoningEffort(args: {
  readonly selectedModel: string | null;
  readonly modelSettings?: ModelSettings | null;
  readonly requested?: ReasoningEffort;
  readonly enabled: boolean;
}):
  | {
      readonly reasoningEffort: ReasoningEffort | undefined;
      readonly modelSettings: ModelSettings;
      readonly modelSettingsPatch: ModelSettingsPatch | undefined;
    }
  | ReturnType<typeof badRequestMessage> {
  const storedSettings = args.modelSettings ?? {};
  if (!args.enabled) {
    if (args.requested !== undefined) {
      return badRequestMessage("Reasoning effort selection is not enabled");
    }
    return {
      reasoningEffort: undefined,
      modelSettings: storedSettings,
      modelSettingsPatch: undefined,
    };
  }
  if (args.requested !== undefined) {
    if (!isModelReasoningEffortSupported(args.selectedModel, args.requested)) {
      return badRequestMessage(
        "Reasoning effort is not supported by the selected model",
      );
    }
  }
  const modelSettingsPatch =
    args.requested !== undefined && isSupportedRunModel(args.selectedModel)
      ? { model: args.selectedModel, effort: args.requested }
      : undefined;
  const modelSettings = modelSettingsPatch
    ? withModelReasoningEffort(storedSettings, modelSettingsPatch)
    : storedSettings;
  return {
    reasoningEffort: modelReasoningEffort(args.selectedModel, modelSettings),
    modelSettings,
    modelSettingsPatch,
  };
}

/**
 * Preserve the preference while adapting execution to the route that actually
 * runs it. Pi has no effort input, while Ultracode currently falls back to the
 * selected model's ordinary default outside its orchestration route.
 */
export function resolveReasoningEffortForDispatch(args: {
  readonly selectedModel: string | null | undefined;
  readonly effort: ReasoningEffort | undefined;
  readonly piExecution: boolean;
}): ReasoningEffort | undefined {
  if (args.effort === undefined || args.piExecution) {
    return undefined;
  }
  if (args.effort === "ultracode") {
    return defaultModelReasoningEffort(args.selectedModel);
  }
  return args.effort;
}
