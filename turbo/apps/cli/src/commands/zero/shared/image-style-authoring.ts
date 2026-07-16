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
  if (source.repo && source.ref) {
    return [
      `- Repository: \`${source.repo}@${source.ref}\``,
      `- Path: \`${source.path}\``,
      `- SKILL.md: \`https://raw.githubusercontent.com/${source.repo}/${source.ref}/${source.path}/SKILL.md\``,
    ];
  }
  return [`- Path: \`${source.path}\``];
}

const outputDir = "./generated/images";
const artifactRules = [
  "Resolve the selected style source before compiling or generating.",
  "Use explicit requirements in the user prompt first, locked style requirements second, and CLI fallback values last.",
  "Keep visual style requirements in the compiled prompt instead of mapping similarly named prose to CLI flags.",
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
    "## Requested Parameters",
    "The generation option values below describe the current CLI invocation and may include CLI defaults. They do not prove explicit user intent; treat them as fallbacks unless the User Prompt explicitly requests the same setting. Source and mask image URLs are user inputs when their value is not `none`.",
    ...options.details.map((detail) => {
      return `- ${detail}`;
    }),
    "",
    "## Parameter Precedence",
    "1. Explicit requirements in the User Prompt, including exact dimensions or aspect ratio.",
    "2. Locked requirements from the selected style source.",
    "3. Compatible generation option values under Requested Parameters, used only as fallbacks.",
    "If explicit user dimensions conflict with the style dimensions, use the user dimensions and preserve the remaining style constraints.",
    "",
    "## Required Stage 1: Resolve Locked Style Source",
    "- Read `SKILL.md` before compiling or generating. The registry summary above is context only and is not a substitute for the source.",
    "- Inspect the files it references, treating assets as required model inputs only when the source marks them so; otherwise they are authoring-only examples.",
    "- If the source cannot be read, stop and report that limitation instead of generating an untemplated image.",
    "",
    "## Required Stage 2: Compile Prompt and Parameters",
    "- Compile one final image prompt that preserves user intent and includes the style's composition, medium, palette, subject handling, reference usage, and must-avoid constraints.",
    "- Resolve generation settings using the Parameter Precedence above. Exact canvas dimensions and output format from the style source may become `--size` and `--format` values when the CLI supports them.",
    "- Keep visual descriptions such as canvas color, background color, composition, medium, palette, and rendering treatment in the compiled prompt. Do not translate them into similarly named CLI flags.",
    "- Only map model, quality, background, or format from the style source to a CLI flag when it explicitly declares a compatible execution setting. In particular, `--background` accepts only `auto`, `opaque`, or `transparent`; a color such as `#f4ecd8` belongs in the compiled prompt.",
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
    "## Next Command Template",
    "```bash",
    'zero generate image --provider built-in --compiled-prompt "<compiled prompt>" <resolved compatible CLI options>',
    "```",
    "Include compatible execution settings resolved from the style source. Use generation option values under Requested Parameters only as fallbacks.",
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
