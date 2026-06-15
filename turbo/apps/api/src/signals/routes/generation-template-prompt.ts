import {
  findDesignSystem,
  findImageStyle,
  findTemplate,
} from "@vm0/core/resource-registry";
import { VIDEO_STYLE_PRESETS, VIDEO_DIMENSION_DESCRIPTIONS } from "@vm0/core";

interface PresentationGenerationTemplateInput {
  readonly type: "presentation";
  readonly selection: {
    readonly designSystemId: string;
    readonly templateId: string;
  };
}

interface VideoGenerationTemplateInput {
  readonly type: "video";
  readonly selection: {
    readonly stylePresetId: string;
  };
}

interface IllustrationGenerationTemplateInput {
  readonly type: "illustration";
  readonly selection: {
    readonly illustrationStyleId: string;
  };
}

type GenerationTemplateInput =
  | PresentationGenerationTemplateInput
  | VideoGenerationTemplateInput
  | IllustrationGenerationTemplateInput;

type GenerationTemplatePromptResult =
  | {
      readonly status: "resolved";
      readonly prompt: string;
    }
  | {
      readonly status: "invalid";
      readonly message: string;
    };

export function buildGenerationTemplatePrompt(
  generationTemplate: GenerationTemplateInput | null | undefined,
): GenerationTemplatePromptResult {
  if (!generationTemplate) {
    return { status: "resolved", prompt: "" };
  }

  if (generationTemplate.type === "video") {
    return buildVideoGenerationTemplatePrompt(generationTemplate);
  }
  if (generationTemplate.type === "illustration") {
    return buildIllustrationGenerationTemplatePrompt(generationTemplate);
  }

  return buildPresentationGenerationTemplatePrompt(generationTemplate);
}

function buildPresentationGenerationTemplatePrompt(
  generationTemplate: PresentationGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const template = findTemplate(generationTemplate.selection.templateId);
  if (!template) {
    return { status: "invalid", message: "Unknown generation template" };
  }
  if (!(template.targets?.includes(generationTemplate.type) ?? false)) {
    return {
      status: "invalid",
      message: "Generation template does not support the requested type",
    };
  }

  const designSystem = findDesignSystem(
    generationTemplate.selection.designSystemId,
  );
  if (!designSystem) {
    return {
      status: "invalid",
      message: "Unknown generation template design system",
    };
  }

  return {
    status: "resolved",
    prompt: [
      "# Generation Template",
      "Use the following registered resources for this run.",
      `Type: ${generationTemplate.type}`,
      `Design system ID: ${designSystem.id}`,
      `Design system name: ${designSystem.name}`,
      `Template ID: ${template.id}`,
      `Template name: ${template.name}`,
      "",
      "Instructions:",
      "- Resolve the design system and template from the resource registry.",
      "- Apply them as generation constraints for the artifact.",
      "- Keep the user's prompt as the source of the requested content.",
    ].join("\n"),
  };
}

function buildVideoGenerationTemplatePrompt(
  generationTemplate: VideoGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const preset = VIDEO_STYLE_PRESETS.find((p) => {
    return p.id === generationTemplate.selection.stylePresetId;
  });
  if (!preset) {
    return { status: "invalid", message: "Unknown video style preset" };
  }

  const describeSlug = (slug: string): string => {
    const desc = VIDEO_DIMENSION_DESCRIPTIONS[slug];
    return desc ? `${slug} — ${desc}` : slug;
  };

  return {
    status: "resolved",
    prompt: [
      "# Video Template Preset",
      `- Preset ID: ${preset.id}`,
      `- Preset name: ${preset.nameEn}`,
      "",
      "- Apply all dimensions and constraints below as hard generation constraints.",
      "- Keep the user's prompt as the source of the requested content.",
      `- Visual Tone: ${describeSlug(preset.dimensions.visualTone)}`,
      `- Camera Style: ${describeSlug(preset.dimensions.cameraStyle)}`,
      `- Editing Pace: ${describeSlug(preset.dimensions.editingPace)}`,
      `- Narrative Mode: ${describeSlug(preset.dimensions.narrativeMode)}`,
      `- Production Type: ${describeSlug(preset.dimensions.productionType)}`,
      `- Emotional Tone: ${describeSlug(preset.dimensions.emotionalTone)}`,
      `- Style Reference: ${describeSlug(preset.dimensions.styleReference)}`,
      "",
      `- Style constraints (inject into the video prompt): ${preset.promptConstraints}`,
      "",
      `- In the final video prompt, reflect every dimension and constraint above for the style ${preset.nameEn}.`,
      "- End the final video prompt with: safe for all audiences, positive and uplifting, no violence, no explicit content",
    ].join("\n"),
  };
}

function buildIllustrationGenerationTemplatePrompt(
  generationTemplate: IllustrationGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const imageStyle = findImageStyle(
    generationTemplate.selection.illustrationStyleId,
  );
  if (!imageStyle) {
    return { status: "invalid", message: "Unknown generation image style" };
  }

  // Context, not control: state the facts about the style the user attached to
  // this chat and their likely intent, then surface the concrete capability
  // fact (the style id is passed to `zero generate image --style`). The agent
  // decides how to act. This replaces the earlier "Resolve the image style from
  // the resource registry" instruction, which told the agent what to do without
  // the facts needed to do it — so when unsure it asked the user to re-pick a
  // style that was already selected (vm0-ai/vm0#17525).
  return {
    status: "resolved",
    prompt: [
      "# User context",
      "",
      "The user has attached an illustration style to this chat:",
      `- Image style ID: ${imageStyle.id}`,
      `- Image style name: ${imageStyle.name}`,
      `- Style summary: ${imageStyle.description}`,
      "",
      "This style stays attached to the chat until the user changes or removes",
      "it, so it also applies to follow-up messages — not just the current one.",
      "",
      "# Likely intent",
      "",
      "Users attach an illustration style when they want images drawn in that",
      "style. When this user asks you to draw, illustrate, or generate an image",
      '— including follow-ups like "another one", "make it landscape", or',
      '"change the background" — they most likely want it rendered in the',
      `"${imageStyle.name}" style. They have already chosen it, so you do not`,
      "need to ask which style to use.",
      "",
      "# How to honor it",
      "",
      "The `zero generate image` capability accepts this style directly via",
      "`--style`, with the user's request as the image content. For example:",
      "",
      `  zero generate image --style ${imageStyle.id} --prompt "<the scene the user described>"`,
      "",
      "Run `zero generate image --help` for the full set of options.",
    ].join("\n"),
  };
}
