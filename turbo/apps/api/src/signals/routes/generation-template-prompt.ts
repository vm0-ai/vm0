import { findDesignSystem, findTemplate } from "@vm0/core/resource-registry";
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

type GenerationTemplateInput =
  | PresentationGenerationTemplateInput
  | VideoGenerationTemplateInput;

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
      `## Video Style: ${preset.nameEn}`,
      "",
      "Apply these style constraints to the user's scene:",
      `- Visual Tone: ${describeSlug(preset.dimensions.visualTone)}`,
      `- Camera Style: ${describeSlug(preset.dimensions.cameraStyle)}`,
      `- Editing Pace: ${describeSlug(preset.dimensions.editingPace)}`,
      `- Narrative Mode: ${describeSlug(preset.dimensions.narrativeMode)}`,
      `- Production Type: ${describeSlug(preset.dimensions.productionType)}`,
      `- Emotional Tone: ${describeSlug(preset.dimensions.emotionalTone)}`,
      `- Style Reference: ${describeSlug(preset.dimensions.styleReference)}`,
      "",
      "Generate a single video prompt (2–3 sentences) that applies the above style to the user's scene.",
      "End with: safe for all audiences, positive and uplifting, no violence, no explicit content",
    ].join("\n"),
  };
}
