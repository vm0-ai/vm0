import {
  type GenerationOutputKind,
  type ImageStyleRegistryEntry,
} from "./resource-registry";

interface StyledImageCompilationOptions {
  readonly prompt: string;
  readonly details: readonly string[];
  readonly style: ImageStyleRegistryEntry;
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

function formatStyleSource(
  source: ImageStyleRegistryEntry["source"],
): readonly string[] {
  return [
    `- Repository: \`${source.repo}@${source.ref}\``,
    `- Path: \`${source.path}\``,
    `- SKILL.md: \`https://raw.githubusercontent.com/${source.repo}/${source.ref}/${source.path}/SKILL.md\``,
  ];
}

const outputDir = "./generated/images";
const artifactRules = [
  "Resolve the selected style source before compiling or generating.",
  "Style-source parameters override CLI fallbacks unless the user explicitly requests an override.",
  "Generate with `--compiled-prompt`, without `--style`, and pass only required reference inputs.",
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
    "Zero is not generating this image yet. Resolve the selected style source, compile the prompt, then generate with `--compiled-prompt`.",
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
    "## Required Stage 1: Resolve Locked Style Source",
    "- Read `SKILL.md` before compiling or generating. The registry summary above is context only and is not a substitute for the source.",
    "- Inspect the files it references, treating assets as required model inputs only when the source marks them so; otherwise they are authoring-only examples.",
    "- If the source cannot be read, stop and report that limitation instead of generating an untemplated image.",
    "",
    "## Required Stage 2: Compile Prompt and Parameters",
    "- Compile one final image prompt that preserves user intent and includes the style's composition, medium, palette, subject handling, reference usage, and must-avoid constraints.",
    "- Resolve model, size, quality, background, and format from the style source. Style-source values override CLI fallbacks; preserve an override only when the user explicitly requested it.",
    "- Return only the compiled prompt text when preparing the next command.",
    "",
    "## Required Stage 3: Generate Image",
    "- After Stages 1 and 2, generate with `--compiled-prompt` and without `--style`.",
    "- Pass one `--image-url` per required model input; do not pass authoring-only examples.",
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
    "## Next Command Template",
    "```bash",
    'zero generate image --provider built-in --compiled-prompt "<compiled prompt>" --model "<resolved model>" --size "<resolved size>" --quality "<resolved quality>" --background "<resolved background>" --format "<resolved format>"',
    "```",
    'Add one `--image-url "<required reference URL>"` per required model input identified in `SKILL.md`.',
    "",
    "## Verification",
    "- Verify the final image exists, is nonblank, and uses the resolved dimensions and other locked parameters.",
    "- Check that required reference anchors were passed and authoring-only examples were not passed.",
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
