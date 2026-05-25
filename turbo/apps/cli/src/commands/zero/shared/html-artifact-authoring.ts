type HtmlArtifactKind = "presentation" | "website";

interface HtmlArtifactAuthoringOptions {
  readonly kind: HtmlArtifactKind;
  readonly prompt: string;
  readonly slugSource?: string;
  readonly site?: string;
  readonly details: readonly string[];
  readonly artifactRules: readonly string[];
}

interface HtmlArtifactAuthoringPacket {
  readonly type: "html-artifact-authoring";
  readonly kind: HtmlArtifactKind;
  readonly prompt: string;
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
  return kind === "presentation" ? "HTML presentation" : "hosted website";
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
  const instructions = [
    `# Zero built-in generate ${options.kind}`,
    "",
    `You are the current agent. Author a production-quality ${title} as a static HTML artifact.`,
    "Zero is not generating this artifact on the server. You are the author.",
    "",
    "## User Prompt",
    options.prompt,
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
    "## OpenDesign-Style Authoring Rules",
    "- Read the local codebase, brand assets, and existing design systems before choosing a visual direction.",
    "- If no design system is available, choose one clear aesthetic direction and hold it across the artifact.",
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
    type: "html-artifact-authoring",
    kind: options.kind,
    prompt: options.prompt,
    outputDir,
    site,
    hostCommand,
    instructions,
  };
}
