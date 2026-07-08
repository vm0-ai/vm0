import {
  type GenerationOutputKind,
  type RegistryEntry,
} from "./resource-registry";

interface StyledImageCompilationOptions {
  readonly prompt: string;
  readonly details: readonly string[];
  readonly style: RegistryEntry;
}

interface StyledImageCompilationPacket {
  readonly type: "image-prompt-compilation";
  readonly kind: "image";
  readonly prompt: string;
  readonly artifact: {
    readonly outputMode: "primary-image";
    readonly primaryArtifact: {
      readonly kind: GenerationOutputKind;
      readonly path: string;
    };
    readonly supportingAssets: readonly {
      readonly kind: GenerationOutputKind | "metadata";
      readonly path: string;
      readonly optional: boolean;
    }[];
    readonly previewKind: "image";
    readonly outputDir: string;
  };
  readonly authoring: {
    readonly details: readonly string[];
    readonly artifactRules: readonly string[];
  };
  readonly outputDir: string;
  readonly instructions: string;
}

function formatStyleSource(source: RegistryEntry["source"]): readonly string[] {
  if ("repo" in source) {
    return [
      `- Repository: \`${source.repo}@${source.ref}\``,
      `- Path: \`${source.path}\``,
    ];
  }
  return [`- Path: \`${source.path}\``];
}

const outputDir = "./generated/images";
const artifactRules = [
  "Compile the user prompt into a final image prompt before generating.",
  "Use the style source, referenced assets, and generation path when they are available.",
  "Generate with `--compiled-prompt`; do not pass `--style` during final image generation.",
] as const;

export function createStyledImageCompilationPacket(
  options: StyledImageCompilationOptions,
): StyledImageCompilationPacket {
  const artifact = {
    outputMode: "primary-image",
    primaryArtifact: {
      kind: "image",
      path: `${outputDir}/`,
    },
    supportingAssets: [
      {
        kind: "metadata",
        path: `${outputDir}/metadata.json`,
        optional: true,
      },
    ],
    previewKind: "image",
    outputDir,
  } as const;
  const instructions = [
    `# Zero generate image prompt compile ${options.style.id}`,
    "",
    "This is an image prompt-compilation packet for the current agent.",
    "Zero is not generating this image yet. The image style has already been selected — compile the user prompt into a final image prompt, then generate with `--compiled-prompt`.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Selected Image Style",
    `- \`${options.style.id}\` — ${options.style.name}`,
    `- ${options.style.description}`,
    "",
    "## Style Source",
    ...formatStyleSource(options.style.source),
    "",
    "## Prompt Compiler Task",
    "- Read the selected style source when available, especially `SKILL.md`, references, examples, and templates.",
    "- Rewrite the user prompt into one final image-generation prompt that obeys the selected style.",
    "- Include style-specific composition, medium, palette, subject handling, reference usage, and must-avoid constraints in the final prompt.",
    "- Keep user intent intact; expand only the visual details needed to satisfy the style.",
    "- Return only the compiled prompt text when preparing the next command.",
    "",
    "## Artifact Output Model",
    `- Primary artifact: \`${artifact.primaryArtifact.kind}\` under \`${artifact.primaryArtifact.path}\`.`,
    `- Output mode: \`${artifact.outputMode}\`.`,
    "- Supporting metadata may live inside the same output directory when useful.",
    "",
    "## Requested Parameters",
    ...options.details.map((detail) => {
      return `- ${detail}`;
    }),
    "",
    "## Image Authoring Rules",
    ...artifactRules.map((rule) => {
      return `- ${rule}`;
    }),
    "",
    "## Next Command Template",
    "```bash",
    'zero generate image --compiled-prompt "<compiled prompt>"',
    "```",
    "",
    "## Verification",
    "- Verify the final image exists and is nonblank.",
    "- Check that the selected style's required reference anchors or source assets were used when applicable.",
    "- Report the final image URL or path and the selected registry resource ID.",
  ].join("\n");

  return {
    type: "image-prompt-compilation",
    kind: "image",
    prompt: options.prompt,
    artifact,
    authoring: {
      details: options.details,
      artifactRules,
    },
    outputDir,
    instructions,
  };
}
