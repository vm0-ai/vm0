import type {
  GenerationTemplateRequest,
  VideoGenerationOptions,
} from "@vm0/api-contracts/contracts/chat-threads";
import { parseAvatarTemplateStylePresetId } from "@vm0/core/avatar-template";
import {
  buildGenerationTemplatePrompt,
  buildGenerationTemplatesPrompt,
  buildVideoGenerationSettingsPrompt,
} from "./generation-template-prompt";

function withVideoSettingsDefaults(
  template: GenerationTemplateRequest,
  videoOptions: VideoGenerationOptions | undefined,
): GenerationTemplateRequest {
  if (
    template.type !== "video" ||
    videoOptions === undefined ||
    parseAvatarTemplateStylePresetId(template.selection.stylePresetId) !==
      undefined
  ) {
    return template;
  }
  return {
    ...template,
    selection: {
      ...template.selection,
      videoOptions: {
        ...videoOptions,
        ...template.selection.videoOptions,
      },
    },
  };
}

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
  readonly videoOptions?: VideoGenerationOptions;
}): string {
  const videoSettingsPrompt = buildVideoGenerationSettingsPrompt(
    args.videoOptions,
  );
  let templatePrompt = "";
  if (args.explicitTemplates && args.explicitTemplates.length > 0) {
    const templates = args.explicitTemplates.map((template) => {
      return withVideoSettingsDefaults(template, args.videoOptions);
    });
    const built = buildGenerationTemplatesPrompt(templates);
    templatePrompt = built.status === "resolved" ? built.prompt : "";
  } else if (args.explicit) {
    const built = buildGenerationTemplatePrompt(
      withVideoSettingsDefaults(args.explicit, args.videoOptions),
    );
    templatePrompt = built.status === "resolved" ? built.prompt : "";
  }
  return [videoSettingsPrompt, templatePrompt]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}
