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
import {
  parseAvatarTemplateStylePresetId,
  readAvatarTemplateOptions,
  type AvatarTemplateOptions,
} from "@vm0/core/avatar-template";
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODEL_CONFIGS,
  type VideoModelConfig,
} from "@vm0/core/video-model-catalog";
import type { VideoGenerationOptions } from "@vm0/api-contracts/contracts/chat-threads";

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
    readonly videoOptions?: VideoGenerationOptions;
    readonly avatarOptions?: AvatarTemplateOptions;
    /** @deprecated Read-only fallback; see readAvatarTemplateOptions. */
    readonly titleSnapshot?: string;
    /** @deprecated Read-only fallback; see readAvatarTemplateOptions. */
    readonly previewUrl?: string;
    /** @deprecated Read-only fallback; see readAvatarTemplateOptions. */
    readonly voiceId?: string;
    /** @deprecated Read-only fallback; see readAvatarTemplateOptions. */
    readonly aspectRatio?: "portrait" | "landscape" | "square";
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
  options: {
    readonly latestWebsiteTemplatesEnabled?: boolean;
  } = {},
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
    return buildWebsiteGenerationTemplatePrompt(
      generationTemplate,
      options.latestWebsiteTemplatesEnabled === true,
    );
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
  options: {
    readonly latestWebsiteTemplatesEnabled?: boolean;
  } = {},
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
  latestWebsiteTemplatesEnabled: boolean,
): GenerationTemplatePromptResult {
  const item = findWebsiteTemplateItem(
    generationTemplate.selection.websiteTemplateId,
  );
  if (!item) {
    return { status: "invalid", message: "Unknown website template" };
  }

  const packageId = latestWebsiteTemplatesEnabled
    ? item.templateId
    : `${item.templateId}-v2`;
  const pkg = findWebsiteTemplatePackage(packageId);
  if (!pkg) {
    return { status: "invalid", message: "Unknown website template" };
  }

  return buildWebsiteTemplatePackagePrompt(
    item,
    pkg,
    latestWebsiteTemplatesEnabled,
  );
}

function buildWebsiteTemplatePackagePrompt(
  item: WebsiteTemplateItem,
  pkg: WebsiteTemplatePackage,
  latestWebsiteTemplatesEnabled: boolean,
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
      `- Template archive SHA-256: ${pkg.source.archive.sha256}`,
      "",
      "When you produce a website from the user's request:",
      `- Pull the package: okou resource pull ${pkg.resourceId} --dir ./generated/resources`,
      `- Work from ${packageDir}. Inspect the bundled package metadata and instructions before editing.`,
      ...(latestWebsiteTemplatesEnabled
        ? [
            "- When generating images for a website, use `seedream4` by default unless the user specifies another image model.",
          ]
        : [
            `- Use ${packageDir}/resolve-images.mjs for image slots when the template asks for image resolution; it uses /api/presentation/images/resolve.`,
          ]),
      `- Render with ${packageDir}/render.mjs after preparing the template content plan.`,
      "- Use this built-in R2-backed package; do not substitute generic Open Design website templates for the selected template.",
      "- Host the finished static website: okou host <output-dir> --site <slug>",
      "- Return the hosted website URL and keep the generated static site as the final deliverable.",
    ].join("\n"),
  };
}

interface SelectedVideoParameter {
  readonly label: string;
  readonly flag: string;
}

/**
 * The generation service rejects a silent MiniMax request outright — that model
 * always returns native audio — and forces silence for a model that cannot
 * generate audio at all. Neither choice survives the request, so it is dropped
 * like any other value the model cannot honour.
 */
function honoursGenerateAudio(
  config: VideoModelConfig,
  generateAudio: boolean,
): boolean {
  if (!config.supportsGenerateAudio) {
    return false;
  }
  return generateAudio || config.provider !== "minimax";
}

/**
 * Options the composer stores are sparse: only what the user touched is
 * present. Values the chosen model cannot honour are dropped rather than
 * rewritten, which leaves the generation service free to apply its own default
 * for that model instead of receiving a value it would reject.
 */
function selectedVideoParameters(
  options: VideoGenerationOptions | undefined,
): readonly SelectedVideoParameter[] {
  if (!options) {
    return [];
  }
  // Annotated so the per-model literal tuples widen to the shared value
  // domains; `includes` below is invariant in its argument.
  //
  // A retired model id can still reach this point: persisted messages and
  // drafts are projected from jsonb without being re-parsed against the
  // contract, so a model dropped from the catalog leaves no config to
  // validate the rest of the selection against.
  const config: VideoModelConfig | undefined =
    VIDEO_MODEL_CONFIGS[options.model ?? DEFAULT_VIDEO_MODEL];
  if (config === undefined) {
    return [];
  }
  const parameters: SelectedVideoParameter[] = [];
  if (options.model !== undefined) {
    parameters.push({
      label: `Model: ${config.alias}`,
      flag: `--model ${config.alias}`,
    });
  }
  if (
    options.aspectRatio !== undefined &&
    config.aspectRatios.includes(options.aspectRatio)
  ) {
    parameters.push({
      label: `Aspect ratio: ${options.aspectRatio}`,
      flag: `--aspect-ratio ${options.aspectRatio}`,
    });
  }
  if (
    options.duration !== undefined &&
    config.durations.includes(options.duration)
  ) {
    parameters.push({
      label: `Duration: ${options.duration}`,
      flag: `--duration ${options.duration}`,
    });
  }
  if (
    options.resolution !== undefined &&
    config.resolutions.includes(options.resolution)
  ) {
    parameters.push({
      label: `Resolution: ${options.resolution}`,
      flag: `--resolution ${options.resolution}`,
    });
  }
  if (
    options.generateAudio !== undefined &&
    honoursGenerateAudio(config, options.generateAudio)
  ) {
    parameters.push({
      label: `Audio: ${options.generateAudio ? "on" : "off"}`,
      // Audio is on by default, so only silence needs a flag.
      flag: options.generateAudio ? "" : "--no-audio",
    });
  }
  return parameters;
}

function buildVideoGenerationTemplatePrompt(
  generationTemplate: VideoGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const avatarId = parseAvatarTemplateStylePresetId(
    generationTemplate.selection.stylePresetId,
  );
  if (avatarId !== undefined) {
    const avatarOptions = readAvatarTemplateOptions(
      generationTemplate.selection,
    );
    return buildAvatarGenerationTemplatePrompt(
      avatarId,
      avatarOptions.voiceId,
      avatarOptions.aspectRatio,
    );
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
  const parameters = selectedVideoParameters(
    generationTemplate.selection.videoOptions,
  );
  const parameterLines =
    parameters.length > 0
      ? [
          "",
          "Parameters the user set explicitly. Keep every one of them; do not",
          "substitute a different model, framing, length, or resolution, and do",
          "not drop a flag because the template suggests another value:",
          ...parameters.map((parameter) => {
            return `- ${parameter.label}`;
          }),
        ]
      : [];
  const generationFlags = parameters
    .map((parameter) => {
      return parameter.flag;
    })
    .filter((flag) => {
      return flag.length > 0;
    })
    .join(" ");
  const finalGenerationLine =
    generationFlags.length > 0
      ? `- Then run final direct video generation from the resolved prompt without \`--template\`, passing \`${generationFlags}\` verbatim.`
      : "- Then run final direct video generation from the resolved prompt and parameters without `--template`.";

  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a video"),
      "Selected video template:",
      "- Artifact type: video",
      `- Template: ${template.name} (${template.id})`,
      `- Template description: ${template.description}`,
      `- Template source: ${templateSource}`,
      ...parameterLines,
      "",
      "When you produce a video from the user's request:",
      `- Run once to fetch the locked video authoring packet: okou generate video --provider built-in --template ${template.id} --prompt "<user request>"`,
      `- The packet points back to the selected template source (${templateSource}); read its SKILL.md before final generation.`,
      finalGenerationLine,
      "- If a connector/provider is requested, follow connector guidance instead.",
      "- If a flag above no longer applies, run `okou generate video -h` to discover the current flags, models, and providers.",
    ].join("\n"),
  };
}

function buildAvatarGenerationTemplatePrompt(
  avatarId: number,
  voiceId: string | undefined,
  aspectRatio: "portrait" | "landscape" | "square" | undefined,
): GenerationTemplatePromptResult {
  const selectedVoiceLines = voiceId
    ? [`- Public JoggAI voice ID: ${voiceId}`]
    : [];
  const voiceInstructionLines = voiceId
    ? [
        `- Keep voice ID ${voiceId} exactly; do not list voices or substitute a different voice.`,
      ]
    : [
        "- List the available voices with `okou generate avatar-video --provider built-in --list-voices --json`, applying a voice-language filter when the user specifies a language, then choose a suitable voice.",
      ];
  const generationVoiceId = voiceId ?? "<voice-id>";
  const generationAspectRatio = aspectRatio ?? "portrait";
  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a talking-avatar video"),
      "Selected talking-avatar template:",
      "- Artifact type: talking-avatar video",
      `- Public JoggAI avatar ID: ${avatarId}`,
      ...selectedVoiceLines,
      `- Aspect ratio: ${generationAspectRatio}`,
      "",
      "When you produce a talking-avatar video from the user's request:",
      `- Keep avatar ID ${avatarId} exactly; do not list avatars or substitute a different avatar.`,
      "- Run `okou generate avatar-video -h` to inspect the current supported flags.",
      ...voiceInstructionLines,
      `- Generate with \`okou generate avatar-video --provider built-in --avatar-id ${avatarId} --voice-id ${generationVoiceId} --aspect-ratio ${generationAspectRatio} --script "<script>"\`.`,
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
  const compileCommand = `okou generate image --provider built-in --style ${imageStyle.id} --prompt "<user request>" --compile --style-source r2`;
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
      '- Then run `okou generate image --provider built-in --compiled-prompt "<compiled prompt>"` with the resolved compatible CLI options and required reference image URLs, without `--style`.',
      "- If a flag above no longer applies, run `okou generate image -h` to discover the current flags, models, providers, and styles.",
    ].join("\n"),
  };
}
