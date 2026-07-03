import {
  findColorSystem,
  findDesignSystem,
  findImageStyle,
  findPresentationRunbookPackage,
  findTemplate,
  findVideoTemplate,
  presentationColorSystemToken,
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

  // Presentation templates that ship a self-contained runbook package use the
  // runbook flow (pull one resource, follow AGENT_RUNBOOK.md, pick the color
  // system at runtime). Templates without a package fall back to the legacy
  // multi-resource flow below.
  const runbookPackage = findPresentationRunbookPackage(
    generationTemplate.selection.templateId,
  );
  if (runbookPackage) {
    return buildPresentationRunbookPrompt(
      generationTemplate,
      template,
      runbookPackage,
    );
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

  const colorSystem = generationTemplate.selection.colorSystemId
    ? findColorSystem(generationTemplate.selection.colorSystemId)
    : undefined;
  if (generationTemplate.selection.colorSystemId && !colorSystem) {
    return {
      status: "invalid",
      message: "Unknown generation template color system",
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
      ...(colorSystem
        ? [
            `- Color system: ${colorSystem.name} (${colorSystem.id})`,
            `- Color system description: ${colorSystem.description}`,
          ]
        : []),
      ...(generationTemplate.selection.previewUrl
        ? [`- Template preview URL: ${generationTemplate.selection.previewUrl}`]
        : []),
      "",
      "Hard rules for presentation template references and media:",
      "- Use selected template references only for structure, layout devices, spacing, and visual language. Do not inherit or continue any reference deck's sample subject, sample story, sample copy, sample metrics, preview imagery, or media seed names.",
      "- Derive every presentation image/media choice from the user's requested topic, story, source material, or cited facts.",
      "",
      "When you produce a presentation from the user's request:",
      `- Run: zero generate presentation --design-system ${designSystem.id} --template ${template.id} --prompt "<user request>"`,
      ...(colorSystem
        ? [
            `- Apply the selected color system (${colorSystem.id}) when authoring the deck.`,
          ]
        : []),
      "- After generating the final HTML deck, from the workspace root run: `npm install --no-save --no-package-lock playwright && node ./generated/resources/presentation-runtime/html-ppt-deck-tools/qa-deck.mjs <output-dir>/index.html`. Fix failures before hosting.",
      "- Follow the returned authoring packet. For a static HTML presentation, publish it with `zero host <dir> --site <slug> --artifact-kind presentation-html`.",
      "- If a flag above no longer applies, run `zero generate presentation -h` to discover the current options.",
    ].join("\n"),
  };
}

function buildPresentationRunbookPrompt(
  generationTemplate: PresentationGenerationTemplateInput,
  template: {
    readonly name: string;
    readonly id: string;
    readonly description: string;
  },
  runbookPackage: PresentationRunbookPackage,
): GenerationTemplatePromptResult {
  const { colorSystemId } = generationTemplate.selection;
  const colorSystemToken = colorSystemId
    ? presentationColorSystemToken(colorSystemId)
    : runbookPackage.defaultColorSystem;
  if (colorSystemId && !colorSystemToken) {
    return {
      status: "invalid",
      message: "Unknown generation template color system",
    };
  }

  const slug = runbookPackage.slug;
  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a presentation"),
      `Selected presentation template: ${template.name} (${template.id})`,
      `Color system token: ${colorSystemToken}`,
      "",
      "To produce the presentation:",
      `- Pull the package: zero resource pull ${runbookPackage.resourceId} --dir ./generated/resources`,
      `- Follow ./generated/resources/${slug}/AGENT_RUNBOOK.md, running its commands from ./generated/resources. Set "colorSystem": "${colorSystemToken}" in the deck JSON.`,
      "- Use the slide count the user asks for; if unspecified, default to 8 pages.",
      "- Host the finished deck: zero host <output-dir> --site <slug> --artifact-kind presentation-html",
      "- Return only the generated HTML deck as the final deliverable.",
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

/**
 * Short, non-instructional label for a generation template selection, meant to be
 * embedded into replayed prior-turn text (see buildWebChatPriorRunsContext) so a
 * later turn can see *when* the selection changed without repeating the full
 * "# Artifact Template Context" instructions for every past turn. There is no
 * thread-sticky persistence for these templates, so this replayed marker is the
 * only way a future turn learns a selection happened here.
 */
export function describeGenerationTemplateSelection(
  generationTemplate: GenerationTemplateInput | null | undefined,
): string | null {
  if (!generationTemplate) {
    return null;
  }
  if (generationTemplate.type === "illustration") {
    const style = findImageStyle(
      generationTemplate.selection.illustrationStyleId,
    );
    return style
      ? `using illustration style "${style.name}" (${style.id})`
      : null;
  }
  if (generationTemplate.type === "video") {
    const template = findVideoTemplate(
      generationTemplate.selection.stylePresetId,
    );
    return template
      ? `using video template "${template.name}" (${template.id})`
      : null;
  }
  if (generationTemplate.type === "presentation") {
    const template = findTemplate(generationTemplate.selection.templateId);
    return template
      ? `using presentation template "${template.name}" (${template.id})`
      : null;
  }
  const template = findWorkflowTemplateItem(
    generationTemplate.selection.workflowTemplateId,
  );
  return template
    ? `using workflow template "${template.title}" (${template.id})`
    : null;
}
