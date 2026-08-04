import {
  buildPresentationRunbookInstructionLines,
  findImageStyle,
  findPresentationRunbookPackage,
  findVideoTemplate,
  findWebsiteTemplatePackage,
  resolvePresentationRunbookColorToken,
  type PresentationRunbookPackage,
  type WebsiteTemplatePackage,
} from "@vm0/core/resource-registry";
import {
  findWebsiteTemplateItem,
  type WebsiteTemplateItem,
} from "@vm0/core/website-template-items";
import { findWorkflowTemplateItem } from "@vm0/core/workflow-template-items";
import { parseAvatarTemplateStylePresetId } from "@vm0/core/avatar-template";

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

function generationTemplateTypeLabel(
  generationTemplate: GenerationTemplateInput,
): string {
  if (
    generationTemplate.type === "video" &&
    parseAvatarTemplateStylePresetId(
      generationTemplate.selection.stylePresetId,
    ) !== undefined
  ) {
    return "avatar";
  }
  return generationTemplate.type;
}

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
): GenerationTemplatePromptResult {
  if (generationTemplates.length === 0) {
    return { status: "resolved", prompt: "" };
  }
  const details: string[] = [];
  for (const [index, generationTemplate] of generationTemplates.entries()) {
    const built = buildGenerationTemplatePrompt(generationTemplate);
    if (built.status === "invalid") {
      return built;
    }
    details.push(
      [
        `## Template #${index + 1} (${generationTemplateTypeLabel(generationTemplate)})`,
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
  const avatarId = parseAvatarTemplateStylePresetId(
    generationTemplate.selection.stylePresetId,
  );
  if (avatarId !== undefined) {
    return buildAvatarGenerationTemplatePrompt(avatarId);
  }

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

function buildAvatarGenerationTemplatePrompt(
  avatarId: number,
): GenerationTemplatePromptResult {
  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a talking-avatar video"),
      "Selected talking-avatar template:",
      "- Artifact type: talking-avatar video",
      `- Public JoggAI avatar ID: ${avatarId}`,
      "",
      "When you produce a talking-avatar video from the user's request:",
      `- Keep avatar ID ${avatarId} exactly; do not list avatars or substitute a different avatar.`,
      "- Run `zero generate avatar-video -h` to inspect the current supported flags.",
      "- List the available voices with `zero generate avatar-video --provider built-in --list-voices --json`, applying a voice-language filter when the user specifies a language, then choose a suitable voice.",
      `- Generate with \`zero generate avatar-video --provider built-in --avatar-id ${avatarId} --voice-id <voice-id> --script "<script>"\`.`,
      "- If the user provides a public audio URL, use `--audio-url` instead of `--script`.",
      "- Return the generated `/f/` video URL as the final deliverable.",
      "- Use a connector/provider only when the user explicitly requests one.",
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
  const styleSource = `private R2 registry resource ${imageStyle.id}`;
  const compileCommand = `zero generate image --provider built-in --style ${imageStyle.id} --prompt "<user request>" --compile --style-source r2`;
  const sourceInstruction =
    "Follow the returned packet completely, including pulling the private R2 package and reading its extracted SKILL.md. If the R2 source is unavailable, stop without generating; do not fall back to GitHub.";

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
