import { createOpenDesignArtifactGenerateCommand } from "../../shared/open-design-artifact-generate";

function standardDetails(kind: string) {
  return (options: { title?: string; audience?: string }) => {
    return [
      `Artifact kind: ${kind}`,
      `Requested title/name: ${options.title ?? "not specified"}`,
      `Audience: ${options.audience ?? "not specified"}`,
    ];
  };
}

export const reportCommand = createOpenDesignArtifactGenerateCommand({
  name: "report",
  target: "report",
  description: "Generate an Open Design HTML report from a prompt",
  usageCommand: "zero built-in generate report",
  examples: `  Generate report:      zero built-in generate report --prompt "A Q2 usage report for the API team"
  Stable hosted slug:    zero built-in generate report --site api-usage-q2 --prompt "A Q2 usage report"`,
  details: standardDetails("report"),
  artifactRules: [
    "Produce an analytical report, not a marketing page.",
    "Use concrete metrics, tables, chart-like visuals, and a clear findings section.",
    "Keep source assumptions visible when the prompt does not provide real data.",
    "Verify the report is readable at desktop and mobile widths.",
  ],
});

export const docsDesignCommand = createOpenDesignArtifactGenerateCommand({
  name: "docs-design",
  target: "docs-design",
  description: "Generate an Open Design documentation design from a prompt",
  usageCommand: "zero built-in generate docs-design",
  examples: `  Generate docs design: zero built-in generate docs-design --prompt "Docs for adding OpenDesign artifact targets"
  Stable hosted slug:    zero built-in generate docs-design --site opendesign-target-docs --prompt "OpenDesign target docs"`,
  details: standardDetails("docs-design"),
  artifactRules: [
    "Produce a documentation design mockup, not a production documentation system.",
    "Include navigation, article structure, code or command examples when relevant, and clear section anchors as static design content.",
    "Use restrained documentation styling optimized for long-form reading.",
    "Verify the page works at mobile and desktop widths.",
  ],
});

export const posterCommand = createOpenDesignArtifactGenerateCommand({
  name: "poster",
  target: "poster",
  description: "Generate an Open Design HTML poster from a prompt",
  usageCommand: "zero built-in generate poster",
  examples: `  Generate poster:      zero built-in generate poster --prompt "A launch poster for OpenDesign artifact targets"
  Stable hosted slug:    zero built-in generate poster --site opendesign-poster --prompt "A launch poster"`,
  details: standardDetails("poster"),
  artifactRules: [
    "Produce a poster-style HTML artifact with strong hierarchy and composition.",
    "Treat this as an HTML poster surface; do not imply a raster image was generated unless image assets are actually created.",
    "Make the poster responsive enough to inspect on mobile and desktop.",
    "Keep text deliberate and avoid placeholder copy.",
  ],
});

export const dashboardDesignCommand = createOpenDesignArtifactGenerateCommand({
  name: "dashboard-design",
  target: "dashboard-design",
  description: "Generate an Open Design dashboard design from a prompt",
  usageCommand: "zero built-in generate dashboard-design",
  examples: `  Generate dash design: zero built-in generate dashboard-design --prompt "An ops dashboard for generation runs"
  Stable hosted slug:    zero built-in generate dashboard-design --site generation-ops --prompt "A generation ops dashboard"`,
  details: standardDetails("dashboard-design"),
  artifactRules: [
    "Produce a dashboard design mockup, not a live operational dashboard.",
    "Include scannable KPIs, chart-like visuals, lists or tables, and realistic empty/loading/error states as static design content.",
    "Prioritize dense, repeat-use UI over decorative sections.",
    "Verify the dashboard does not overflow at desktop and mobile widths.",
  ],
});

export const mobileAppDesignCommand = createOpenDesignArtifactGenerateCommand({
  name: "mobile-app-design",
  target: "mobile-app-design",
  description:
    "Generate an Open Design mobile app design prototype from a prompt",
  usageCommand: "zero built-in generate mobile-app-design",
  examples: `  Generate mobile UI:   zero built-in generate mobile-app-design --prompt "A mobile review screen for generation artifacts"
  Stable hosted slug:    zero built-in generate mobile-app-design --site generation-mobile-review --prompt "A mobile review screen"`,
  details: standardDetails("mobile-app-design"),
  artifactRules: [
    "Produce a design prototype, not a runnable or installable mobile app.",
    "Render the design inside a realistic phone frame with status bar, device chrome, and home indicator when possible.",
    "Focus on one mobile screen and one primary job.",
    "Use mobile-appropriate tap targets, type sizes, and spacing.",
  ],
});
