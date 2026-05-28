import {
  type GenerationOutputKind,
  type ResourceCandidateSlice,
  type RegistryEntry,
  selectResourceCandidates,
} from "./resource-registry";

interface StyledImageAuthoringOptions {
  readonly prompt: string;
  readonly details: readonly string[];
  readonly style: RegistryEntry;
}

interface StyledImageAuthoringPacket {
  readonly type: "generation-source-selection";
  readonly kind: "image";
  readonly prompt: string;
  readonly registryVersion: string;
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
  readonly selection: {
    readonly candidates: ResourceCandidateSlice["candidates"];
    readonly outputSchema: {
      readonly imageStyle: "string";
      readonly skills: "string[]";
      readonly rationale: "string";
    };
  };
  readonly authoring: {
    readonly details: readonly string[];
    readonly artifactRules: readonly string[];
  };
  readonly outputDir: string;
  readonly instructions: string;
}

const outputDir = "./generated/images";
const artifactRules = [
  "Resolve the selected style source before generating the image.",
  "Use the style skill's referenced assets and generation path when it provides one.",
  "Produce a single final image file and keep any temporary metadata under the output directory.",
] as const;

export function createStyledImageAuthoringPacket(
  options: StyledImageAuthoringOptions,
): StyledImageAuthoringPacket {
  const baseSlice = selectResourceCandidates();
  const candidateSlice: ResourceCandidateSlice = {
    ...baseSlice,
    candidates: {
      ...baseSlice.candidates,
      imageStyles: [options.style],
    },
  };
  const selectionSchema = {
    imageStyle: "string",
    skills: "string[]",
    rationale: "string",
  } as const;
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
    `# Zero generate image --style ${options.style.id}`,
    "",
    "This is a federated generation source-selection packet for the current agent.",
    "Zero is not generating this image on the server yet. The image style has already been selected by the caller — resolve it and generate the styled image.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Selected Image Style",
    `- \`${options.style.id}\` — ${options.style.name}`,
    "",
    "## Stage 1: Supporting Resource Selection",
    "- The image style is locked. Optionally pick supporting skills/templates from the candidate slice below.",
    "- Choose only IDs present in this packet; do not invent registry IDs.",
    "- Treat the selection JSON as internal working state, then continue to generation.",
    "",
    "## Selection Output Schema",
    "```json",
    JSON.stringify(selectionSchema, null, 2),
    "```",
    "",
    "## Candidate Registry Slice",
    `Registry: \`${candidateSlice.registryVersion}\``,
    "Sources:",
    ...candidateSlice.sources.map((src) => {
      return `- \`${src.repo}@${src.ref}\``;
    }),
    "",
    "```json",
    JSON.stringify(candidateSlice.candidates, null, 2),
    "```",
    "",
    "## Stage 2: Resolve Selected Resources",
    "- Fetch or read the selected resource source before generation.",
    "- Each candidate carries a `source` object with `path` and optional `repo`/`ref`; when `repo`/`ref` are omitted, fall back to the registry-level source above.",
    "- For directory refs, inspect the most relevant files such as `SKILL.md`, references, examples, and templates.",
    "- If a source file cannot be fetched, state that limitation and fall back to the registry metadata for that resource.",
    "",
    "## Stage 3: Generate Image",
    "- Generate one production-quality image using the selected style.",
    "- Follow the selected style skill's generation path when it defines one.",
    "- If the style skill delegates to a model or connector, use that flow directly instead of restating the style text manually.",
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
    "## Verification",
    "- Verify the final image exists and is nonblank.",
    "- Check that the selected style's required reference anchors or source assets were used when applicable.",
    "- Report the final image URL or path and the selected registry resource ID.",
  ].join("\n");

  return {
    type: "generation-source-selection",
    kind: "image",
    prompt: options.prompt,
    registryVersion: candidateSlice.registryVersion,
    artifact,
    selection: {
      candidates: candidateSlice.candidates,
      outputSchema: selectionSchema,
    },
    authoring: {
      details: options.details,
      artifactRules,
    },
    outputDir,
    instructions,
  };
}
