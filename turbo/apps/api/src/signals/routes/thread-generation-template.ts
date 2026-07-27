import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
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
  readonly websiteTemplateV2Enabled?: boolean;
  readonly imageStyleR2Enabled?: boolean;
}): string {
  if (args.explicitTemplates && args.explicitTemplates.length > 0) {
    const built = buildGenerationTemplatesPrompt(args.explicitTemplates, {
      websiteTemplateV2Enabled: args.websiteTemplateV2Enabled,
      imageStyleR2Enabled: args.imageStyleR2Enabled,
    });
    return built.status === "resolved" ? built.prompt : "";
  }
  if (!args.explicit) {
    return "";
  }
  const built = buildGenerationTemplatePrompt(args.explicit, {
    websiteTemplateV2Enabled: args.websiteTemplateV2Enabled,
    imageStyleR2Enabled: args.imageStyleR2Enabled,
  });
  return built.status === "resolved" ? built.prompt : "";
}
