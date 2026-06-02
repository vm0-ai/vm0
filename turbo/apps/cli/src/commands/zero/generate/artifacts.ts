import { createArtifactGenerateCommand } from "../shared/artifact-generate";

function standardDetails(kind: string) {
  return (options: { title?: string }) => {
    return [
      `Artifact kind: ${kind}`,
      `Requested title/name: ${options.title ?? "not specified"}`,
    ];
  };
}

export const reportCommand = createArtifactGenerateCommand({
  name: "report",
  generationType: "report",
  target: "report",
  description: "Generate an HTML report from a prompt",
  usageCommand: "zero generate report",
  examples: `  Generate report:      zero generate report --prompt "A Q2 usage report for the API team"
  Stable hosted slug:    zero generate report --site-slug api-usage-q2 --prompt "A Q2 usage report"
  Show choices:          zero generate report`,
  details: standardDetails("report"),
  artifactRules: [
    "Produce an analytical report, not a marketing page.",
    "Use concrete metrics, tables, chart-like visuals, and a clear findings section.",
    "Keep source assumptions visible when the prompt does not provide real data.",
    "Verify the report is readable at desktop and mobile widths.",
  ],
});

export const docsDesignCommand = createArtifactGenerateCommand({
  name: "docs-design",
  generationType: "docs-design",
  target: "docs-design",
  description: "Generate a documentation design from a prompt",
  usageCommand: "zero generate docs-design",
  examples: `  Generate docs design: zero generate docs-design --prompt "Docs for adding artifact targets"
  Stable hosted slug:    zero generate docs-design --site-slug artifact-target-docs --prompt "Artifact target docs"
  Show choices:          zero generate docs-design`,
  details: standardDetails("docs-design"),
  artifactRules: [
    "Produce a documentation design mockup, not a production documentation system.",
    "Include navigation, article structure, code or command examples when relevant, and clear section anchors as static design content.",
    "Use restrained documentation styling optimized for long-form reading.",
    "Verify the page works at mobile and desktop widths.",
  ],
});

export const posterCommand = createArtifactGenerateCommand({
  name: "poster",
  generationType: "poster",
  target: "poster",
  description: "Generate an HTML poster from a prompt",
  usageCommand: "zero generate poster",
  examples: `  Generate poster:      zero generate poster --prompt "A launch poster for artifact targets"
  Stable hosted slug:    zero generate poster --site-slug artifact-poster --prompt "A launch poster"
  Show choices:          zero generate poster`,
  details: standardDetails("poster"),
  artifactRules: [
    "Produce a poster-style HTML artifact with strong hierarchy and composition.",
    "Treat this as an HTML poster surface; do not imply a raster image was generated unless image assets are actually created.",
    "Make the poster responsive enough to inspect on mobile and desktop.",
    "Keep text deliberate and avoid placeholder copy.",
  ],
});

export const dashboardDesignCommand = createArtifactGenerateCommand({
  name: "dashboard-design",
  generationType: "dashboard-design",
  target: "dashboard-design",
  description: "Generate a dashboard design from a prompt",
  usageCommand: "zero generate dashboard-design",
  examples: `  Generate dash design: zero generate dashboard-design --prompt "An ops dashboard for generation runs"
  Stable hosted slug:    zero generate dashboard-design --site-slug generation-ops --prompt "A generation ops dashboard"
  Show choices:          zero generate dashboard-design`,
  details: standardDetails("dashboard-design"),
  artifactRules: [
    "Produce a dashboard design mockup, not a live operational dashboard.",
    "Include scannable KPIs, chart-like visuals, lists or tables, and realistic empty/loading/error states as static design content.",
    "Prioritize dense, repeat-use UI over decorative sections.",
    "Verify the dashboard does not overflow at desktop and mobile widths.",
  ],
});

export const mobileAppDesignCommand = createArtifactGenerateCommand({
  name: "mobile-app-design",
  generationType: "mobile-app-design",
  target: "mobile-app-design",
  description: "Generate a mobile app design prototype from a prompt",
  usageCommand: "zero generate mobile-app-design",
  examples: `  Generate mobile UI:   zero generate mobile-app-design --prompt "A mobile review screen for generation artifacts"
  Stable hosted slug:    zero generate mobile-app-design --site-slug generation-mobile-review --prompt "A mobile review screen"
  Show choices:          zero generate mobile-app-design`,
  details: standardDetails("mobile-app-design"),
  artifactRules: [
    "Produce a design prototype, not a runnable or installable mobile app.",
    "Render the design inside a realistic phone frame with status bar, device chrome, and home indicator when possible.",
    "Focus on one mobile screen and one primary job.",
    "Use mobile-appropriate tap targets, type sizes, and spacing.",
  ],
});
