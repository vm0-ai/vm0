import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import {
  buildGenerationTemplatePrompt,
  buildGenerationTemplatesPrompt,
} from "./generation-template-prompt";

/**
 * Resolve the generation-template system prompt for a chat run.
 *
 * One-shot only: the prompt is built from the selection attached to *this*
 * message and nothing else. There is no thread-level default: a follow-up
 * message that doesn't reattach a template resolves to "".
 */
export function resolveThreadGenerationTemplatePrompt(args: {
  readonly explicit: GenerationTemplateRequest | null | undefined;
  readonly explicitTemplates?: readonly GenerationTemplateRequest[];
  readonly introVideoTemplatesEnabled: boolean;
  readonly latestPresentationTemplatesEnabled: boolean;
  readonly presentationTemplatesEnabled: boolean;
  /**
   * Private template row ids whose packages the run being built will mount.
   * Required rather than optional so every caller states what its run carries.
   */
  readonly mountedUserPresentationTemplateIds: readonly string[];
}): string {
  const options = {
    introVideoTemplatesEnabled: args.introVideoTemplatesEnabled,
    latestPresentationTemplatesEnabled: args.latestPresentationTemplatesEnabled,
    presentationTemplatesEnabled: args.presentationTemplatesEnabled,
    mountedUserPresentationTemplateIds: args.mountedUserPresentationTemplateIds,
  };
  if (args.explicitTemplates && args.explicitTemplates.length > 0) {
    const built = buildGenerationTemplatesPrompt(
      args.explicitTemplates,
      options,
    );
    return built.status === "resolved" ? built.prompt : "";
  }
  if (!args.explicit) {
    return "";
  }
  const built = buildGenerationTemplatePrompt(args.explicit, options);
  return built.status === "resolved" ? built.prompt : "";
}
