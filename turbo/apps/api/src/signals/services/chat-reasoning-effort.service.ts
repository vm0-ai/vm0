import {
  compatibleReasoningEffort,
  isModelReasoningEffortSupported,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { badRequestMessage } from "../../lib/error";

/** Keep saved preferences dormant while rollout is disabled. */
export function resolveChatReasoningEffort(args: {
  readonly selectedModel: string | null;
  readonly stored?: ReasoningEffort | null;
  readonly requested?: ReasoningEffort | null;
  readonly enabled: boolean;
}):
  | {
      readonly reasoningEffort: ReasoningEffort | null;
      readonly persistedReasoningEffort: ReasoningEffort | null;
    }
  | ReturnType<typeof badRequestMessage> {
  if (!args.enabled) {
    if (args.requested !== undefined) {
      return badRequestMessage("Reasoning effort selection is not enabled");
    }
    return {
      reasoningEffort: null,
      persistedReasoningEffort: args.stored ?? null,
    };
  }
  if (args.requested !== undefined && args.requested !== null) {
    if (!isModelReasoningEffortSupported(args.selectedModel, args.requested)) {
      return badRequestMessage(
        "Reasoning effort is not supported by the selected model",
      );
    }
  }
  const reasoningEffort =
    args.requested === null
      ? null
      : (args.requested ??
        compatibleReasoningEffort(args.selectedModel, args.stored));
  return {
    reasoningEffort,
    persistedReasoningEffort: reasoningEffort,
  };
}

/**
 * Keep dispatch closed until the native runtime consumers ship in #32903 PR 2.
 * Feature switches accept user overrides, so the rollout flag alone cannot
 * prevent a requested setting from being silently ignored by older runtimes.
 */
export function validateReasoningEffortDispatch(
  effort: ReasoningEffort | null | undefined,
) {
  return effort === null || effort === undefined
    ? undefined
    : badRequestMessage(
        "Reasoning effort execution is not available yet. Restore the model default to run this message.",
      );
}
