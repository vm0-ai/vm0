import {
  type GenerationOutputKind,
  type ResourceCandidateSlice,
  type GenerationTarget,
  selectResourceCandidates,
} from "./resource-registry";

type HtmlArtifactKind = GenerationTarget;

interface HtmlArtifactAuthoringOptions {
  readonly kind: HtmlArtifactKind;
  readonly prompt: string;
  readonly slugSource?: string;
  readonly siteSlug?: string;
  readonly details: readonly string[];
  readonly artifactRules: readonly string[];
}

interface HtmlArtifactAuthoringPacket {
  readonly type: "generation-source-selection";
  readonly kind: HtmlArtifactKind;
  readonly prompt: string;
  readonly registryVersion: string;
  readonly artifact: {
    readonly outputMode: "primary-artifact-with-supporting-assets";
    readonly primaryArtifact: {
      readonly kind: GenerationOutputKind;
      readonly path: string;
    };
    readonly supportingAssets: readonly {
      readonly kind: GenerationOutputKind | "metadata";
      readonly path: string;
      readonly optional: boolean;
    }[];
    readonly previewKind: "hosted-url";
    readonly outputDir: string;
  };
  readonly selection: {
    readonly candidates: ResourceCandidateSlice["candidates"];
    readonly outputSchema: {
      readonly skills: "string[]";
      readonly template: "string";
      readonly designSystem: "string | null";
      readonly imageStyle: "string | null";
      readonly audioStyle: "string | null";
      readonly videoTemplate: "string | null";
      readonly bundleTemplate: "string | null";
      readonly rationale: "string";
    };
  };
  readonly authoring: {
    readonly details: readonly string[];
    readonly artifactRules: readonly string[];
  };
  readonly outputDir: string;
  readonly site: string;
  readonly hostCommand: string;
  readonly instructions: string;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug.length >= 3 ? slug : "html-artifact";
}

function titleForKind(kind: HtmlArtifactKind): string {
  const titles: Record<HtmlArtifactKind, string> = {
    image: "image",
    presentation: "HTML presentation",
    website: "hosted website",
    "dashboard-design": "dashboard design prototype",
    "mobile-app-design": "mobile app design prototype",
    poster: "poster",
    "intro-video": "intro video storyboard",
    report: "report",
    "docs-design": "documentation design prototype",
  };

  return titles[kind];
}

function outputDirForSite(site: string): string {
  return `./generated/mockups/${site}`;
}

export function createHtmlArtifactAuthoringPacket(
  options: HtmlArtifactAuthoringOptions,
): HtmlArtifactAuthoringPacket {
  const site =
    options.siteSlug ?? slugify(options.slugSource ?? options.prompt);
  const outputDir = outputDirForSite(site);
  const artifactKindFlag =
    options.kind === "presentation" ? " --artifact-kind presentation-html" : "";
  const hostCommand = `zero host ${outputDir} --site ${site}${artifactKindFlag}${
    options.kind === "website" ? " --spa" : ""
  }`;
  const title = titleForKind(options.kind);
  const candidateSlice = selectResourceCandidates(options.kind);
  const selectionSchema = {
    skills: "string[]",
    template: "string",
    designSystem: "string | null",
    imageStyle: "string | null",
    audioStyle: "string | null",
    videoTemplate: "string | null",
    bundleTemplate: "string | null",
    rationale: "string",
  } as const;
  const artifact = {
    outputMode: "primary-artifact-with-supporting-assets",
    primaryArtifact: {
      kind: options.kind as GenerationOutputKind,
      path: `${outputDir}/index.html`,
    },
    supportingAssets: [
      {
        kind: "image",
        path: `${outputDir}/assets/`,
        optional: true,
      },
      {
        kind: "audio",
        path: `${outputDir}/assets/`,
        optional: true,
      },
      {
        kind: "video",
        path: `${outputDir}/assets/`,
        optional: true,
      },
      {
        kind: "metadata",
        path: `${outputDir}/metadata.json`,
        optional: true,
      },
    ],
    previewKind: "hosted-url",
    outputDir,
  } as const;
  const instructions = [
    `# Zero generate ${options.kind}`,
    "",
    "This is a federated generation source-selection packet for the current agent.",
    `Zero is not generating this ${title} on the server. You select resources, resolve them, and author the artifact.`,
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Stage 1: Resource Selection",
    "- Choose generation resources from the bundled federated registry slice below.",
    "- Select one template, one or more skills, zero or one design system, and optional media/style resources when relevant.",
    "- Choose only IDs present in this packet; do not invent registry IDs.",
    "- Prefer compatible resources, but the user prompt is the highest-priority signal.",
    "- Treat the selection JSON as internal working state, then continue to authoring.",
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
    "- For every selected resource, fetch or read the referenced source before authoring.",
    "- Each candidate carries a `source` object with `path` and optional `repo`/`ref`; when `repo`/`ref` are omitted, fall back to the registry-level source above.",
    "- For directory refs, inspect the most relevant files such as `SKILL.md`, `DESIGN.md`, `README.md`, tokens, examples, and templates.",
    "- If a source file cannot be fetched, state that limitation and fall back to the registry metadata for that resource.",
    "",
    "## Stage 3: Author Artifact",
    `Author a production-quality ${title} as a static HTML artifact using the selected generation resources.`,
    "",
    "## Artifact Output Model",
    `- Primary artifact: \`${artifact.primaryArtifact.kind}\` at \`${artifact.primaryArtifact.path}\`.`,
    `- Output mode: \`${artifact.outputMode}\`.`,
    "- Supporting images, audio, video, or metadata may live inside the same output directory when the result needs them.",
    "- Treat the output directory as a project bundle when multiple media types are generated, while keeping the HTML entry point primary.",
    "",
    "## Output Contract",
    `- Write the artifact under \`${outputDir}/\`.`,
    `- The entry file must be \`${outputDir}/index.html\`.`,
    "- Keep every local asset inside the same output directory.",
    "- Do not reference files from another project path.",
    "- Use descriptive filenames and canonical HTML: close non-void tags and double-quote attributes.",
    "- Prefer a single self-contained HTML file unless the artifact genuinely needs separate assets.",
    "",
    "## Requested Parameters",
    ...options.details.map((detail) => {
      return `- ${detail}`;
    }),
    "",
    "## Authoring Rules",
    "- Let the selected template define structure, the selected design system define visual language, and the selected skills define process.",
    "- Read the local codebase, brand assets, and existing design systems when the prompt depends on this repository.",
    "- Avoid generic AI design defaults: no stock SaaS gradients, no emoji-as-icons, no filler stats, no decorative chrome that does not help the artifact.",
    "- Build the actual artifact first, not a marketing explanation of the artifact.",
    "- Make controls and interactions real when they are visible.",
    "- Keep text readable at desktop and mobile preview sizes.",
    ...options.artifactRules.map((rule) => {
      return `- ${rule}`;
    }),
    "",
    "## Verification",
    "- Use `agent-browser` for browser verification when available. Start with `agent-browser skills get core` if you need command guidance.",
    "- Prefer `agent-browser` over Playwright, Puppeteer, or installing browser automation dependencies.",
    "- Open the HTML locally and verify it is nonblank.",
    "- Check that keyboard/click interactions work when present.",
    "- Check that text does not overflow or overlap at desktop and mobile viewport sizes.",
    "- Run the final hosting command only after the artifact looks correct.",
    "",
    "## Publish",
    `When everything is OK, publish it with:`,
    "",
    "```bash",
    hostCommand,
    "```",
  ].join("\n");

  return {
    type: "generation-source-selection",
    kind: options.kind,
    prompt: options.prompt,
    registryVersion: candidateSlice.registryVersion,
    artifact,
    selection: {
      candidates: candidateSlice.candidates,
      outputSchema: selectionSchema,
    },
    authoring: {
      details: options.details,
      artifactRules: options.artifactRules,
    },
    outputDir,
    site,
    hostCommand,
    instructions,
  };
}
