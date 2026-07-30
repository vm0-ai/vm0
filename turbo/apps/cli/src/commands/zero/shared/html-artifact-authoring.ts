import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { decodeZeroTokenPayload } from "../../../lib/api/zero-token";
import {
  type GenerationOutputKind,
  type ResourceCandidateSlice,
  type GenerationTarget,
  selectResourceCandidates,
} from "./resource-registry";

type HtmlArtifactKind = GenerationTarget;

const HTML_RESOURCE_REGISTRY = {
  url: "https://static.vm0.io/vm0/html-resource-registry/v2/0899a14208b6a4775b326ebbaf08cf76973ebdb99fbb2fb6eb3a9f23be3f8c58/registry.json",
  sha256: "0899a14208b6a4775b326ebbaf08cf76973ebdb99fbb2fb6eb3a9f23be3f8c58",
  path: "/tmp/vm0-html-resource-registry-v2.json",
} as const;

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
    readonly outputSchema:
      | {
          readonly skills: "string[]";
          readonly template: "string";
          readonly designSystem: "string | null";
          readonly rationale: "string";
        }
      | {
          readonly resource: "string";
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

function formatCandidateSource(
  source: ResourceCandidateSlice["sources"][number],
): string {
  if ("repo" in source) {
    return `- \`${source.repo}@${source.ref}\``;
  }
  return `- ${source.description}`;
}

function artifactResourceRegistrySearchEnabled(): boolean {
  const payload = decodeZeroTokenPayload();
  return isFeatureEnabled(FeatureSwitchKey.ArtifactResourceRegistrySearch, {
    userId: payload?.userId,
    orgId: payload?.orgId,
    overrides: payload?.featureSwitchOverrides,
  });
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
  const registrySearchEnabled = artifactResourceRegistrySearchEnabled();
  const candidateSlice = selectResourceCandidates(options.kind);
  const selectionSchema = registrySearchEnabled
    ? ({
        resource: "string",
        rationale: "string",
      } as const)
    : ({
        skills: "string[]",
        template: "string",
        designSystem: "string | null",
        rationale: "string",
      } as const);
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
  const packetIntroduction = registrySearchEnabled
    ? "This is a generation resource-selection packet for the current agent."
    : "This is a federated generation source-selection packet for the current agent.";
  const resourceSelectionInstructions = registrySearchEnabled
    ? [
        "## Stage 1: Search Resource Registry",
        "- If Requested Parameters explicitly name resources, treat those IDs as required. Otherwise choose exactly one best target-compatible resource.",
        "- Derive 3-8 concise English keywords and synonyms from the user prompt. Translate non-English concepts into English search terms.",
        "- Search only target-compatible IDs, matching keywords against each resource's `name`, `description`, and `tags`.",
        "- Run separate or broader keyword searches when needed, but do not print the full Registry into context.",
        "- Choose only IDs returned by the Registry; do not invent resource IDs.",
        "- Treat the selection JSON as internal working state, then continue to resolution.",
        "",
        "## Selection Output Schema",
        "```json",
        JSON.stringify(selectionSchema, null, 2),
        "```",
        "",
        "## Static Resource Registry",
        `URL: \`${HTML_RESOURCE_REGISTRY.url}\``,
        `SHA-256: \`${HTML_RESOURCE_REGISTRY.sha256}\``,
        "",
        "Download, verify, narrow by the current target, then search with `rg -i`:",
        "",
        "```bash",
        `curl -fsSL "${HTML_RESOURCE_REGISTRY.url}" -o "${HTML_RESOURCE_REGISTRY.path}"`,
        `echo "${HTML_RESOURCE_REGISTRY.sha256}  ${HTML_RESOURCE_REGISTRY.path}" | sha256sum --check`,
        `jq -r --arg target "${options.kind}" '`,
        "  (",
        "    .indexes.targets[$target].skills",
        "    + ([.indexes.targets[$target].templates[]] | add)",
        "    + .indexes.shared.designSystems",
        "  )[] as $id",
        "  | .resourcesById[$id] as $resource",
        "  | [",
        "      $id,",
        "      $resource.kind,",
        "      $resource.name,",
        "      $resource.description,",
        '      ($resource.tags | join(" "))',
        "    ]",
        "  | @tsv",
        `' "${HTML_RESOURCE_REGISTRY.path}" | rg -i '<keyword|synonym>'`,
        "```",
      ]
    : [
        "## Stage 1: Resource Selection",
        "- Choose generation resources from the bundled federated registry slice below.",
        "- Select one template, one or more skills, and zero or one design system.",
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
        ...candidateSlice.sources.map(formatCandidateSource),
        "",
        "```json",
        JSON.stringify(candidateSlice.candidates, null, 2),
        "```",
      ];
  const resourceResolutionInstructions = registrySearchEnabled
    ? [
        "## Stage 2: Resolve Selected Resources",
        "- Read only each selected or explicitly required resource and its source resolver:",
        "",
        "```bash",
        `jq --arg id "<selected-resource-id>" '{ resource: .resourcesById[$id], source: .sources[.resourcesById[$id].source] }' "${HTML_RESOURCE_REGISTRY.path}"`,
        "```",
        "",
        "- Download only the selected or explicitly required resources; do not clone or pull every candidate.",
        "- For `openDesign`, follow the Registry's three Git sparse-checkout steps and checkout its fixed commit.",
        "- For `websiteR2`, run the Registry's authenticated `zero resource pull` command.",
        "- For directory refs, inspect the most relevant files such as `SKILL.md`, `DESIGN.md`, `README.md`, tokens, examples, and templates.",
        "- If a source file cannot be fetched, state that limitation and fall back to the Registry metadata for that resource.",
      ]
    : [
        "## Stage 2: Resolve Selected Resources",
        "- First resolve every required resource listed above, then resolve every selected resource before authoring.",
        "- Each candidate carries a `source` object with `path` and optional `repo`/`ref`; when `repo`/`ref` are omitted, fall back to the registry-level source above.",
        "- If `source.archive` is present, pull the private R2 archive with `zero resource pull <resource-id> --dir ./generated/resources`; the CLI requests an authenticated short-lived download URL, verifies the digest, and then extracts `source.path`.",
        "- For directory refs, inspect the most relevant files such as `SKILL.md`, `DESIGN.md`, `README.md`, tokens, examples, and templates.",
        "- If a source file cannot be fetched, state that limitation and fall back to the registry metadata for that resource.",
      ];
  const selectedResourceAuthoringRule = registrySearchEnabled
    ? "- Let each resolved resource define the applicable structure, process, or visual language based on its kind."
    : "- Let the selected template define structure, the selected design system define visual language, and the selected skills define process.";
  const instructions = [
    `# Zero generate ${options.kind}`,
    "",
    packetIntroduction,
    `Zero is not generating this ${title} on the server. You select resources, resolve them, and author the artifact.`,
    "",
    "## User Prompt",
    options.prompt,
    "",
    ...resourceSelectionInstructions,
    "",
    ...resourceResolutionInstructions,
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
    selectedResourceAuthoringRule,
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
    "- Check that shapes, charts, images, or decorative graphics do not cover readable text at desktop and mobile viewport sizes.",
    "- Run the final hosting command only after the artifact looks correct.",
    "",
    "## Publish",
    "The hosted URL is the preview and user-accessible view for this static HTML artifact.",
    `When everything is OK, publish it with:`,
    "",
    "```bash",
    hostCommand,
    "```",
    "",
    "File upload is a separate delivery channel for when the user needs a local file copy, not another way to preview the same hosted artifact.",
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
