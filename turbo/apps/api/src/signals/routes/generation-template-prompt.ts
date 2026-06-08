import { findDesignSystem, findTemplate } from "@vm0/core/resource-registry";

interface PresentationGenerationTemplateInput {
  readonly type: "presentation";
  readonly selection: {
    readonly designSystemId: string;
    readonly templateId: string;
  };
}

type GenerationTemplateInput = PresentationGenerationTemplateInput;

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
