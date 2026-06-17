import {
  type GenerationOutputKind,
  type ResourceCandidateSlice,
  type VideoTemplateRegistryEntry,
  selectResourceCandidates,
} from "./resource-registry";

interface VideoTemplateAuthoringOptions {
  readonly prompt: string;
  readonly details: readonly string[];
  readonly template: VideoTemplateRegistryEntry;
}

interface VideoTemplateAuthoringPacket {
  readonly type: "generation-source-selection";
  readonly kind: "video";
  readonly prompt: string;
  readonly registryVersion: string;
  readonly artifact: {
    readonly outputMode: "primary-video";
    readonly primaryArtifact: {
      readonly kind: GenerationOutputKind;
      readonly path: string;
    };
    readonly supportingAssets: readonly {
      readonly kind: GenerationOutputKind | "metadata";
      readonly path: string;
      readonly optional: boolean;
    }[];
    readonly previewKind: "video";
    readonly outputDir: string;
  };
  readonly selection: {
    readonly candidates: ResourceCandidateSlice["candidates"];
    readonly outputSchema: {
      readonly videoTemplate: "string";
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

function formatCandidateSource(
  source: ResourceCandidateSlice["sources"][number],
): string {
  if ("repo" in source) {
    return `- \`${source.repo}@${source.ref}\``;
  }
  return `- ${source.description}`;
}

const outputDir = "./generated/videos";
const artifactRules = [
  "Resolve the selected video template source before generating the video.",
  "Use the template skill's locked dimensions, prompt construction rules, generation parameters, worked examples, and reference output.",
  "Keep the user's subject and intent; use the selected template only to shape the video's look and generation parameters.",
  "Always end the final video prompt with: safe for all audiences, positive and uplifting, no violence, no explicit content.",
  "Do not pass --template again when you run the final video generation command from this packet.",
] as const;

export function createVideoTemplateAuthoringPacket(
  options: VideoTemplateAuthoringOptions,
): VideoTemplateAuthoringPacket {
  const baseSlice = selectResourceCandidates();
  const candidateSlice: ResourceCandidateSlice = {
    ...baseSlice,
    candidates: {
      ...baseSlice.candidates,
      videoTemplates: [options.template],
    },
  };
  const selectionSchema = {
    videoTemplate: "string",
    skills: "string[]",
    rationale: "string",
  } as const;
  const artifact = {
    outputMode: "primary-video",
    primaryArtifact: {
      kind: "video",
      path: `${outputDir}/`,
    },
    supportingAssets: [
      {
        kind: "metadata",
        path: `${outputDir}/metadata.json`,
        optional: true,
      },
    ],
    previewKind: "video",
    outputDir,
  } as const;
  const instructions = [
    `# Zero generate video --template ${options.template.id}`,
    "",
    "This is a federated generation source-selection packet for the current agent.",
    "Zero is not generating this video on the server yet. The video template has already been selected by the caller - resolve it and generate the templated video.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Selected Video Template",
    `- \`${options.template.id}\` - ${options.template.name}`,
    "",
    "## Stage 1: Supporting Resource Selection",
    "- The video template is locked. Optionally pick supporting skills/templates from the candidate slice below.",
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
    ...candidateSlice.sources.map(formatCandidateSource),
    "",
    "```json",
    JSON.stringify(candidateSlice.candidates, null, 2),
    "```",
    "",
    "## Stage 2: Resolve Selected Resources",
    "- Fetch or read the selected resource source before generation.",
    "- Each candidate carries a `source` object with `path` and optional `repo`/`ref`; when `repo`/`ref` are omitted, fall back to the registry-level source above.",
    "- If `source.archive` is present, pull the private R2 archive with `zero resource pull <resource-id> --dir ./generated/resources`; the CLI requests an authenticated short-lived download URL, verifies the digest, and then extracts `source.path`.",
    "- For directory refs, inspect the most relevant files such as `SKILL.md`, references, examples, and templates.",
    "- If a source file cannot be fetched, state that limitation and fall back to the registry metadata for that resource.",
    "",
    "## Stage 3: Generate Video",
    "- Generate one production-quality video using the selected template.",
    "- Follow the selected template skill's generation path and parameter guidance when it defines one.",
    "- Use direct video generation with the resolved prompt and parameters; do not invoke this same --template packet recursively.",
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
    "## Video Authoring Rules",
    ...artifactRules.map((rule) => {
      return `- ${rule}`;
    }),
    "",
    "## Verification",
    "- Verify the final video exists and is nonblank.",
    "- Check that the selected template's locked dimensions and reference output were respected when applicable.",
    "- Report the final video URL or path and the selected registry resource ID.",
  ].join("\n");

  return {
    type: "generation-source-selection",
    kind: "video",
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
