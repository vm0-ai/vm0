import {
  type OpenDesignCandidateSlice,
  type OpenDesignTarget,
  selectOpenDesignCandidates,
} from "./open-design-registry";

type HtmlArtifactKind = OpenDesignTarget;

interface HtmlArtifactAuthoringOptions {
  readonly kind: HtmlArtifactKind;
  readonly prompt: string;
  readonly slugSource?: string;
  readonly site?: string;
  readonly details: readonly string[];
  readonly artifactRules: readonly string[];
}

interface HtmlArtifactAuthoringPacket {
  readonly type: "open-design-resource-selection";
  readonly kind: HtmlArtifactKind;
  readonly prompt: string;
  readonly registryVersion: string;
  readonly selection: {
    readonly candidates: OpenDesignCandidateSlice["candidates"];
    readonly outputSchema: {
      readonly skills: "string[]";
      readonly template: "string";
      readonly designSystem: "string | null";
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
    presentation: "HTML presentation",
    website: "hosted website",
    dashboard: "dashboard",
    "mobile-app": "mobile app prototype",
    poster: "poster",
    "intro-video": "intro video storyboard",
    report: "report",
    docs: "documentation site",
  };

  return titles[kind];
}

function outputDirForSite(site: string): string {
  return `./opendesign/mockups/${site}`;
}

export function createHtmlArtifactAuthoringPacket(
  options: HtmlArtifactAuthoringOptions,
): HtmlArtifactAuthoringPacket {
  const site = options.site ?? slugify(options.slugSource ?? options.prompt);
  const outputDir = outputDirForSite(site);
  const hostCommand = `zero host ${outputDir} --site ${site}${
    options.kind === "website" ? " --spa" : ""
  }`;
  const title = titleForKind(options.kind);
  const candidateSlice = selectOpenDesignCandidates({
    target: options.kind,
    prompt: [
      options.prompt,
      options.slugSource ?? "",
      ...options.details,
      ...options.artifactRules,
    ].join("\n"),
  });
  const selectionSchema = {
    skills: "string[]",
    template: "string",
    designSystem: "string | null",
    rationale: "string",
  } as const;
  const instructions = [
    `# Zero built-in generate ${options.kind}`,
    "",
    "This is an Open Design resource-selection packet for the current agent.",
    `Zero is not generating this ${title} on the server. You select resources, resolve them, and author the artifact.`,
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Stage 1: Resource Selection",
    "- Choose the Open Design resources from the bundled registry slice below.",
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
    "",
    "```json",
    JSON.stringify(candidateSlice.candidates, null, 2),
    "```",
    "",
    "## Stage 2: Resolve Selected Resources",
    "- For every selected resource, fetch or read the referenced Open Design source before authoring.",
    "- Source refs are pinned as `repo@commit:path`; use the commit in the packet for reproducibility.",
    "- For directory refs, inspect the most relevant files such as `SKILL.md`, `DESIGN.md`, `README.md`, tokens, examples, and templates.",
    "- If a source file cannot be fetched, state that limitation and fall back to the registry metadata for that resource.",
    "",
    "## Stage 3: Author Artifact",
    `Author a production-quality ${title} as a static HTML artifact using the selected Open Design resources.`,
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
    "## Open Design Authoring Rules",
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
    type: "open-design-resource-selection",
    kind: options.kind,
    prompt: options.prompt,
    registryVersion: candidateSlice.registryVersion,
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
