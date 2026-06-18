import {
  findDesignSystem,
  findImageStyle,
  findTemplate,
  findVideoTemplate,
} from "@vm0/core/resource-registry";

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

// Shared framing for every artifact-template block, kept in one place so the
// three builders cannot drift. It balances two jobs that pull in opposite
// directions:
//   1. The user *deliberately* selected this template — a strong signal, so it is
//      the default style for that artifact, and the agent must not re-ask for an
//      already-selected style (vm0-ai/vm0#17525).
//   2. The selection must not hijack unrelated turns. This block is injected on
//      every run while the template is thread-sticky (see resolveThread-
//      GenerationTemplatePrompt), including messages that have nothing to do with
//      generation, so the "does not force you to generate" boundary is load-
//      bearing, not decorative.
// State the facts and hand back the decision, rather than naming a step ("resolve
// from the registry") without the facts needed to act on it.
function templateFraming(artifactNoun: string): readonly string[] {
  return [
    "# Artifact Template Context",
    "",
    `- The user deliberately selected this artifact template for the chat — treat it as the default style for any ${artifactNoun} you produce here, including in follow-up messages.`,
    `- It does not force you to generate: the user's prompt decides the task, content, output format, and whether to produce an artifact at all. If a request isn't about producing ${artifactNoun}, just answer it normally.`,
    "- Other artifact templates, files, or attachments may also be present.",
    "",
  ];
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
      ...templateFraming("a presentation"),
      "Selected presentation style:",
      `- Artifact type: ${generationTemplate.type}`,
      `- Design system: ${designSystem.name} (${designSystem.id})`,
      `- Design system description: ${designSystem.description}`,
      `- Template: ${template.name} (${template.id})`,
      `- Template description: ${template.description}`,
      "",
      "When you produce a presentation from the user's request:",
      `- Run: zero generate presentation --design-system ${designSystem.id} --template ${template.id} --prompt "<user request>"`,
      "- Follow the returned authoring packet. For a static HTML presentation, publish it with `zero host <dir> --site <slug> --artifact-kind presentation-html`.",
      "- If a flag above no longer applies, run `zero generate presentation -h` to discover the current options.",
    ].join("\n"),
  };
}

function buildVideoGenerationTemplatePrompt(
  generationTemplate: VideoGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const template = findVideoTemplate(
    generationTemplate.selection.stylePresetId,
  );
  if (!template) {
    return { status: "invalid", message: "Unknown video template" };
  }
  const sourceRepo = template.source.repo;
  const sourceRef = template.source.ref;
  const sourcePath = template.source.path;
  const templateSource = `${sourceRepo}@${sourceRef}:${sourcePath}`;

  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a video"),
      "Selected video template:",
      "- Artifact type: video",
      `- Template: ${template.name} (${template.id})`,
      `- Template description: ${template.description}`,
      `- Template source: ${templateSource}`,
      "",
      "When you produce a video from the user's request:",
      `- Run once to fetch the locked video authoring packet: zero generate video --provider built-in --template ${template.id} --prompt "<user request>"`,
      `- The packet points back to the selected template source (${templateSource}); read its SKILL.md before final generation.`,
      "- Then run final direct video generation from the resolved prompt and parameters without `--template`.",
      "- If a connector/provider is requested, follow connector guidance instead.",
      "- If a flag above no longer applies, run `zero generate video -h` to discover the current flags, models, and providers.",
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
      ...templateFraming("an illustration or image"),
      "Selected illustration style:",
      "- Artifact type: illustration",
      `- Style: ${imageStyle.name} (${imageStyle.id})`,
      `- Style description: ${imageStyle.description}`,
      "",
      "When you produce an illustration or image from the user's request:",
      `- Run: zero generate image --provider built-in --style ${imageStyle.id} --prompt "<user request>"`,
      "- If a flag above no longer applies, run `zero generate image -h` to discover the current flags, models, providers, and styles.",
    ].join("\n"),
  };
}
