import {
  buildPresentationRunbookInstructionLines,
  findImageStyle,
  findPresentationRunbookPackage,
  findVideoTemplate,
  findWebsiteTemplatePackage,
  hasR2Archive,
  resolvePresentationRunbookColorToken,
  type PresentationRunbookPackage,
  type WebsiteTemplatePackage,
} from "@vm0/core/resource-registry";
import {
  findWebsiteTemplateItem,
  type WebsiteTemplateItem,
} from "@vm0/core/website-template-items";
import { findWorkflowTemplateItem } from "@vm0/core/workflow-template-items";

interface PresentationGenerationTemplateInput {
  readonly type: "presentation";
  readonly selection: {
    readonly templateId: string;
    readonly colorSystemId?: string;
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

interface WebsiteGenerationTemplateInput {
  readonly type: "website";
  readonly selection: {
    readonly websiteTemplateId: string;
  };
}

type GenerationTemplateInput =
  | PresentationGenerationTemplateInput
  | VideoGenerationTemplateInput
  | IllustrationGenerationTemplateInput
  | WorkflowGenerationTemplateInput
  | WebsiteGenerationTemplateInput;

type GenerationTemplatePromptResult =
  | {
      readonly status: "resolved";
      readonly prompt: string;
    }
  | {
      readonly status: "invalid";
      readonly message: string;
    };

interface BuildGenerationTemplatePromptOptions {
  /**
   * When true, archive-enabled image styles resolve through private R2.
   * When false, the existing vm0-skills GitHub source remains unchanged.
   */
  readonly imageStyleR2Enabled?: boolean;
}

export function buildGenerationTemplatePrompt(
  generationTemplate: GenerationTemplateInput | null | undefined,
  options?: BuildGenerationTemplatePromptOptions,
): GenerationTemplatePromptResult {
  if (!generationTemplate) {
    return { status: "resolved", prompt: "" };
  }

  if (generationTemplate.type === "video") {
    return buildVideoGenerationTemplatePrompt(generationTemplate);
  }
  if (generationTemplate.type === "illustration") {
    return buildIllustrationGenerationTemplatePrompt(
      generationTemplate,
      options,
    );
  }
  if (generationTemplate.type === "workflow") {
    return buildWorkflowGenerationTemplatePrompt(generationTemplate);
  }
  if (generationTemplate.type === "website") {
    return buildWebsiteGenerationTemplatePrompt(generationTemplate);
  }

  return buildPresentationGenerationTemplatePrompt(generationTemplate);
}

function stripGenerationTemplateContext(prompt: string): string {
  const lines = prompt.split("\n");
  if (lines[0] === "# Workflow Template Context") {
    return lines.slice(lines[1] === "" ? 2 : 1).join("\n");
  }
  if (lines[0] !== "# Artifact Template Context") {
    return prompt;
  }
  const framingEnd = lines.findIndex((line, index) => {
    return index > 1 && line === "";
  });
  return lines.slice(framingEnd + 1).join("\n");
}

export function buildGenerationTemplatesPrompt(
  generationTemplates: readonly GenerationTemplateInput[],
  options?: BuildGenerationTemplatePromptOptions,
): GenerationTemplatePromptResult {
  if (generationTemplates.length === 0) {
    return { status: "resolved", prompt: "" };
  }
  const details: string[] = [];
  for (const [index, generationTemplate] of generationTemplates.entries()) {
    const built = buildGenerationTemplatePrompt(generationTemplate, options);
    if (built.status === "invalid") {
      return built;
    }
    details.push(
      [
        `## Template #${index + 1} (${generationTemplate.type})`,
        "",
        stripGenerationTemplateContext(built.prompt),
      ].join("\n"),
    );
  }
  return {
    status: "resolved",
    prompt: [
      "# Inline Templates",
      "",
      "Match each numbered template marker in the current user message with the same numbered section below.",
      "- Apply each template only to the request around its marker.",
      "- A template is context, not a request by itself.",
      "",
      details.join("\n\n"),
    ].join("\n"),
  };
}

function templateFraming(artifactNoun: string): readonly string[] {
  return [
    "# Artifact Template Context",
    "",
    `- The user deliberately selected this artifact template for this run — treat it as the default style whenever you produce ${artifactNoun} here.`,
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
  // Presentation picker selections are valid only when they resolve to a
  // self-contained runbook package. The legacy multi-resource registry flow has
  // been retired, so ids without a runbook package are rejected.
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

function buildWebsiteGenerationTemplatePrompt(
  generationTemplate: WebsiteGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const item = findWebsiteTemplateItem(
    generationTemplate.selection.websiteTemplateId,
  );
  if (!item) {
    return { status: "invalid", message: "Unknown website template" };
  }

  const packageId = `${item.templateId}-v2`;
  const pkg = findWebsiteTemplatePackage(packageId);
  if (!pkg) {
    return { status: "invalid", message: "Unknown website template" };
  }

  return buildWebsiteTemplatePackagePrompt(item, pkg);
}

function buildWebsiteTemplatePackagePrompt(
  item: WebsiteTemplateItem,
  pkg: WebsiteTemplatePackage,
): GenerationTemplatePromptResult {
  const packageDir = `./generated/resources/${pkg.slug}`;

  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a website"),
      "Selected website template:",
      "- Artifact type: website",
      `- Template: ${item.title} (${item.id})`,
      `- Template description: ${pkg.description}`,
      `- Template package id: ${pkg.templateId}`,
      `- Package resource: ${pkg.resourceId}`,
      "",
      "When you produce a website from the user's request:",
      `- Pull the package: zero resource pull ${pkg.resourceId} --dir ./generated/resources`,
      `- Work from ${packageDir}. Inspect the bundled package metadata and instructions before editing.`,
      `- Use ${packageDir}/resolve-images.mjs for image slots when the template asks for image resolution; it uses /api/presentation/images/resolve.`,
      `- Render with ${packageDir}/render.mjs after preparing the template content plan.`,
      "- Use this built-in R2-backed package; do not substitute generic Open Design website templates for the selected template.",
      "- Host the finished static website: zero host <output-dir> --site <slug>",
      "- Return the hosted website URL and keep the generated static site as the final deliverable.",
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
  options?: BuildGenerationTemplatePromptOptions,
): GenerationTemplatePromptResult {
  const imageStyle = findImageStyle(
    generationTemplate.selection.illustrationStyleId,
  );
  if (!imageStyle) {
    return { status: "invalid", message: "Unknown generation image style" };
  }
  const useR2 =
    options?.imageStyleR2Enabled === true && hasR2Archive(imageStyle);
  const styleSource = useR2
    ? `private R2 registry resource ${imageStyle.id}`
    : imageStyle.source.repo && imageStyle.source.ref
      ? `${imageStyle.source.repo}@${imageStyle.source.ref}:${imageStyle.source.path}`
      : imageStyle.source.path;
  const compileCommand = [
    `zero generate image --provider built-in --style ${imageStyle.id}`,
    '--prompt "<user request>" --compile',
    ...(useR2 ? ["--style-source r2"] : []),
  ].join(" ");
  const sourceInstruction = useR2
    ? "Follow the returned packet completely, including pulling the private R2 package and reading its extracted SKILL.md. If the R2 source is unavailable, stop without generating; do not fall back to GitHub."
    : `Follow the returned packet completely, including reading its style source (${styleSource}) and SKILL.md. If the source is unavailable, stop without generating.`;

  return {
    status: "resolved",
    prompt: [
      ...templateFraming("an illustration or image"),
      "Selected illustration style:",
      "- Artifact type: illustration",
      `- Style: ${imageStyle.name} (${imageStyle.id})`,
      `- Style description: ${imageStyle.description}`,
      `- Style source: ${styleSource}`,
      "",
      "When you produce an illustration or image from the user's request:",
      `- Run once: ${compileCommand}`,
      `- ${sourceInstruction}`,
      '- Then run `zero generate image --provider built-in --compiled-prompt "<compiled prompt>"` with the resolved compatible CLI options and required reference image URLs, without `--style`.',
      "- If a flag above no longer applies, run `zero generate image -h` to discover the current flags, models, providers, and styles.",
    ].join("\n"),
  };
}
