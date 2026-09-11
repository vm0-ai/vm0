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
 * Native admission requires #32999 deployed and incompatible old runners drained.
 * Keep unsupported routes and modes closed even under a user flag override.
 */
export function validateReasoningEffortDispatch(
  effort: ReasoningEffort | null | undefined,
  piExecution: boolean,
) {
  if (effort === null || effort === undefined) {
    return undefined;
  }
  if (piExecution) {
    return badRequestMessage(
      "Reasoning effort selection is not supported by this execution route. Restore the model default to run this message.",
    );
  }
  // Claude Code accepts --effort ultracode but silently uses ordinary xhigh
  // when workflow orchestration is unavailable. Keep admission closed until the
  // runtime can establish mode availability for the actual provider/session.
  if (effort === "ultracode") {
    return badRequestMessage(
      "Ultracode execution is not available yet. Choose another effort level or restore the model default.",
    );
  }
  return undefined;
}
