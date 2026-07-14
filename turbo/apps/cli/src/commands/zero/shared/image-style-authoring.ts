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
  "Resolve and read the selected style source before compiling the prompt or generating the image.",
  "Treat the registry summary as context only, not as a substitute for the style source.",
  "Use the style skill's locked prompt rules, generation parameters, and required reference inputs.",
  "Style-source parameters override CLI fallbacks unless the user explicitly requests an override.",
  "Generate with `--compiled-prompt`; do not pass `--style` during final image generation.",
  "If the style source cannot be read, stop and report the limitation instead of generating.",
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
    "Zero is not generating this image yet. The image style has already been selected — resolve its source before compiling the user prompt, then generate with `--compiled-prompt`.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Selected Image Style",
    `- \`${options.style.id}\` — ${options.style.name}`,
    `- ${options.style.desc ?? options.style.description}`,
    "",
    "## Style Source",
    ...formatStyleSource(options.style.source),
    "",
    "## Required Stage 1: Resolve Locked Style Source",
    "- Fetch or read the selected style source before drafting the compiled prompt or running image generation.",
    "- Read `SKILL.md` first. The registry summary above is context only and is not a substitute for the source.",
    "- Inspect the references, examples, and templates that `SKILL.md` points to.",
    "- Determine which reference assets are required model inputs and which are authoring-only examples; do not assume every bundled image is an input.",
    "- If the source cannot be read, stop and report that limitation instead of generating an untemplated image.",
    "",
    "## Required Stage 2: Compile Prompt and Parameters",
    "- Rewrite the user prompt into one final image-generation prompt that obeys the selected style.",
    "- Include style-specific composition, medium, palette, subject handling, reference usage, and must-avoid constraints in the final prompt.",
    "- Keep user intent intact; expand only the visual details needed to satisfy the style.",
    "- Resolve model, size, quality, background, and format from the style source. Style-source values override CLI fallbacks; preserve an override only when the user explicitly requested it.",
    "- Return only the compiled prompt text when preparing the next command.",
    "",
    "## Required Stage 3: Generate Image",
    "- Do not generate until Stages 1 and 2 are complete.",
    "- Pass one `--image-url` per reference that `SKILL.md` marks as a required model input.",
    "- Do not pass authoring-only examples as image inputs.",
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
    'zero generate image --provider built-in --compiled-prompt "<compiled prompt>" --model "<resolved model>" --size "<resolved size>" --quality "<resolved quality>" --background "<resolved background>" --format "<resolved format>"',
    "```",
    'Add one `--image-url "<required reference URL>"` per required model input identified in `SKILL.md`.',
    "",
    "## Verification",
    "- Verify the final image exists and is nonblank.",
    "- Check that the selected style's resolved dimensions and other locked parameters were used.",
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
