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
      "# Artifact Template Context",
      "",
      "The user selected a presentation artifact template for this chat.",
      "This is context, not control: the selection signals interest in this template and design-system style, and the user may want a presentation artifact if that fits the current request.",
      "The user's prompt remains the source of truth for the task, content, output format, and whether to generate anything. Other artifact templates, files, or attachments may also be present.",
      "",
      "Selected presentation resources:",
      `- Artifact type: ${generationTemplate.type}`,
      `- Design system: ${designSystem.name} (${designSystem.id})`,
      `- Design system description: ${designSystem.description}`,
      `- Template: ${template.name} (${template.id})`,
      `- Template description: ${template.description}`,
      "",
      "Relevant Zero generation commands:",
      "- Run `zero generate presentation -h` to inspect the current flags.",
      "- Run `zero generate presentation` to list available design systems and templates.",
      `- If producing a presentation from the user's request, use \`zero generate presentation --design-system ${designSystem.id} --template ${template.id} --prompt "<user request>"\`.`,
      "- Follow the returned authoring packet. For a static HTML presentation, author the artifact and publish it with `zero host <dir> --site <slug> --artifact-kind presentation-html`.",
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
      "# Artifact Template Context",
      "",
      "The user selected a video artifact template preset for this chat.",
      "This is context, not control: the selection signals interest in this video style, and the user may want a video artifact if that fits the current request.",
      "The user's prompt remains the source of truth for the task, content, output format, and whether to generate anything. Other artifact templates, files, or attachments may also be present.",
      "",
      "Selected video style preset:",
      "- Artifact type: video",
      `- Preset: ${preset.nameEn} (${preset.id})`,
      `- Visual tone: ${describeSlug(preset.dimensions.visualTone)}`,
      `- Camera style: ${describeSlug(preset.dimensions.cameraStyle)}`,
      `- Editing pace: ${describeSlug(preset.dimensions.editingPace)}`,
      `- Narrative mode: ${describeSlug(preset.dimensions.narrativeMode)}`,
      `- Production type: ${describeSlug(preset.dimensions.productionType)}`,
      `- Emotional tone: ${describeSlug(preset.dimensions.emotionalTone)}`,
      `- Style reference: ${describeSlug(preset.dimensions.styleReference)}`,
      `- Prompt style notes: ${preset.promptConstraints}`,
      "",
      "Relevant Zero generation commands:",
      "- Run `zero generate video -h` to inspect the current flags, models, and built-in options.",
      "- Run `zero generate video` to list available providers for video generation.",
      '- If producing a video from the user\'s request, use `zero generate video --provider built-in --prompt "<user request plus relevant style context>"` or follow connector guidance when a connector/provider is requested.',
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

  return {
    status: "resolved",
    prompt: [
      "# Artifact Template Context",
      "",
      "The user selected an illustration artifact template style for this chat.",
      "This is context, not control: the selection signals interest in this illustration style, and the user may want an illustration or image artifact if that fits the current request.",
      "The user's prompt remains the source of truth for the task, content, output format, and whether to generate anything. Other artifact templates, files, or attachments may also be present.",
      "This selected illustration style can persist across follow-up messages in the same chat.",
      "",
      "Selected illustration style:",
      "- Artifact type: illustration",
      `- Style: ${imageStyle.name} (${imageStyle.id})`,
      `- Style description: ${imageStyle.description}`,
      "",
      "Relevant Zero generation commands:",
      "- Run `zero generate image -h` to inspect the current flags, models, providers, and style registry options.",
      "- Run `zero generate image` to list available providers for image generation.",
      `- If producing an illustration or image from the user's request, use \`zero generate image --provider built-in --style ${imageStyle.id} --prompt "<user request>"\`.`,
    ].join("\n"),
  };
}
