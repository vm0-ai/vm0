import {
  buildPresentationRunbookInstructionLines,
  findImageStyle,
  findPresentationRunbookPackage,
  findVideoTemplate,
  resolvePresentationRunbookColorToken,
  type PresentationRunbookPackage,
} from "@vm0/core/resource-registry";
import { findWorkflowTemplateItem } from "@vm0/core/workflow-template-items";

interface PresentationGenerationTemplateInput {
  readonly type: "presentation";
  readonly selection: {
    readonly colorSystemId?: string;
    readonly designSystemId: string;
    readonly templateId: string;
    readonly previewUrl?: string;
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

interface WorkflowGenerationTemplateInput {
  readonly type: "workflow";
  readonly selection: {
    readonly workflowTemplateId: string;
  };
}

type GenerationTemplateInput =
  | PresentationGenerationTemplateInput
  | VideoGenerationTemplateInput
  | IllustrationGenerationTemplateInput
  | WorkflowGenerationTemplateInput;

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
  if (generationTemplate.type === "workflow") {
    return buildWorkflowGenerationTemplatePrompt(generationTemplate);
  }

  return buildPresentationGenerationTemplatePrompt(generationTemplate);
}

// Shared framing for every artifact-template block, kept in one place so the
// three builders cannot drift. It balances two jobs that pull in opposite
// directions:
//   1. The user *deliberately* selected this template — a strong signal, so it is
//      the default style for that artifact in this run, and the agent must not
//      re-ask for an already-selected style (vm0-ai/vm0#17525).
//   2. The selection must not hijack unrelated work in this run, so the "does
//      not force you to generate" boundary is load-bearing, not decorative.
// State the facts and hand back the decision, rather than naming a step ("resolve
// from the registry") without the facts needed to act on it.
function templateFraming(artifactNoun: string): readonly string[] {
  return [
    "# Artifact Template Context",
    "",
    `- The user deliberately selected this artifact template for this run — treat it as the default style for any ${artifactNoun} you produce here.`,
    `- It does not force you to generate: the user's prompt decides the task, content, output format, and whether to produce an artifact at all. If a request isn't about producing ${artifactNoun}, just answer it normally.`,
    "- Other artifact templates, files, or attachments may also be present.",
    "",
  ];
}

function buildWorkflowGenerationTemplatePrompt(
  generationTemplate: WorkflowGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const template = findWorkflowTemplateItem(
    generationTemplate.selection.workflowTemplateId,
  );
  if (!template) {
    return { status: "invalid", message: "Unknown workflow template" };
  }
  return { status: "resolved", prompt: template.promptGuidance };
}

function buildPresentationGenerationTemplatePrompt(
  generationTemplate: PresentationGenerationTemplateInput,
): GenerationTemplatePromptResult {
  // Presentation generation templates are served exclusively from their
  // self-contained runbook package. The legacy multi-resource flow and its
  // `template:html-ppt-*` / `design-system:*` registry entries have been
  // retired, so a template id without a runbook package is not a valid
  // selection.
  const runbookPackage = findPresentationRunbookPackage(
    generationTemplate.selection.templateId,
  );
  if (!runbookPackage) {
    return { status: "invalid", message: "Unknown generation template" };
  }
  return buildPresentationRunbookPrompt(generationTemplate, runbookPackage);
}

function buildPresentationRunbookPrompt(
  generationTemplate: PresentationGenerationTemplateInput,
  runbookPackage: PresentationRunbookPackage,
): GenerationTemplatePromptResult {
  const color = resolvePresentationRunbookColorToken(
    runbookPackage,
    generationTemplate.selection.colorSystemId,
  );
  if ("error" in color) {
    return {
      status: "invalid",
      message: "Unknown generation template color system",
    };
  }

  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a presentation"),
      ...buildPresentationRunbookInstructionLines({
        runbookPackage,
        colorSystemToken: color.token,
      }),
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
