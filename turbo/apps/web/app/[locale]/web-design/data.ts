export type GalleryCategory =
  | "illustration"
  | "presentation"
  | "website"
  | "report"
  | "video"
  | "audio";

export type GalleryPreviewKind = "image" | "website" | "video" | "audio";

export interface GalleryItem {
  readonly slug: string;
  readonly category: GalleryCategory;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly previewImage: string;
  readonly artifactUrl?: string;
  readonly previewKind: GalleryPreviewKind;
  readonly generationKind: string;
  readonly resourceHints?: readonly string[];
  readonly skillId?: string;
  readonly templateId?: string;
  readonly designSystemId?: string;
}

export const GALLERY_CATEGORIES: readonly (GalleryCategory | "all")[] = [
  "all",
  "website",
];

export const GALLERY_CATEGORY_LABELS: Record<GalleryCategory | "all", string> =
  {
    all: "All",
    illustration: "Illustration",
    presentation: "Presentation",
    website: "Website Design",
    report: "Report",
    video: "Video",
    audio: "Audio",
  };

export const GALLERY_ITEMS: readonly GalleryItem[] = [
  {
    slug: "launch-metrics-command-center",
    category: "website",
    title: "Launch Metrics Command Center",
    description:
      "A founder-facing SaaS metrics dashboard with activation, retention, revenue, support load, release health, and ranked opportunities.",
    prompt:
      "Create a polished website for a SaaS launch metrics command center. Show activation, retention, revenue, support load, release health, ranked opportunities, and a concise executive summary. Make it feel like a quiet operational dashboard that a founder could scan every morning.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/751a6c2a-cd82-4322-86a4-dc1a1b9ab7a3/gallery-trial-data-dashboard-dashboard-hosted.png",
    artifactUrl:
      "https://gallery-trial-data-dashboard-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:data-report",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:dashboard",
    resourceHints: [
      "od:skill:data-report",
      "od:template:dashboard",
      "od:design-system:dashboard",
    ],
  },
  {
    slug: "market-risk-monitor",
    category: "website",
    title: "Market Risk Monitor",
    description:
      "A dark terminal-style market risk surface with liquidity, volatility, exposure, alerts, and watchlists for fast analyst scanning.",
    prompt:
      "Create a polished website for a real-time market risk monitor. Show liquidity, volatility, exposure, alerts, watchlists, and a concise risk summary for an investment team. Make it feel like a dark, high-density trading terminal with clear charts and fast scanning.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/57d4059d-a65e-4807-b21a-a6f6ae1b4f57/gallery-trial-data-dashboard-terminal-hosted.png",
    artifactUrl:
      "https://gallery-trial-data-dashboard-terminal-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:data-report",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:trading-terminal",
    resourceHints: [
      "od:skill:data-report",
      "od:template:dashboard",
      "od:design-system:trading-terminal",
    ],
  },
  {
    slug: "ai-infrastructure-cost-report",
    category: "website",
    title: "AI Infrastructure Cost Report",
    description:
      "A board-ready finance report covering spend trends, unit economics, margin pressure, vendor concentration, and optimization opportunities.",
    prompt:
      "Create a polished executive website report about AI infrastructure cost efficiency. Include spend trends, unit economics, gross margin pressure, vendor concentration, optimization opportunities, risks, and a clear recommendation section. Make it feel like a rigorous board-ready report with practical charts and tables.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d35e7d77-fb4f-42f7-a9c9-c41282e0c7f5/hosted-screenshot.png",
    artifactUrl:
      "https://gallery-trial-data-finance-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:data-report",
    templateId: "od:template:finance-report",
    designSystemId: "od:design-system:dashboard",
    resourceHints: [
      "od:skill:data-report",
      "od:template:finance-report",
      "od:design-system:dashboard",
    ],
  },
  {
    slug: "api-usage-analytics-docs",
    category: "website",
    title: "API Usage Analytics Docs",
    description:
      "A precise documentation page for developer-platform analytics, event taxonomy, query examples, interpretation, and data quality checks.",
    prompt:
      "Create a polished website that documents API usage analytics for a developer platform. Include metric definitions, event taxonomy, query examples, dashboard interpretation, anomaly notes, and a concise data quality checklist. Make it feel precise, minimal, and technical without becoming cluttered.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d1f09f14-f861-4a79-9a40-794b11e04e12/hosted-screenshot-visible.png",
    artifactUrl: "https://gallery-trial-data-docs-mono-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:data-report",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:mono",
    resourceHints: [
      "od:skill:data-report",
      "od:template:docs-page",
      "od:design-system:mono",
    ],
  },
  {
    slug: "urban-microfactories",
    category: "website",
    title: "Urban Microfactories",
    description:
      "A premium editorial feature about urban microfactories, told through strong headlines, field notes, expert quotes, and image-led sections.",
    prompt:
      "Create a polished editorial website feature about the rise of urban microfactories. Tell the story through strong headlines, image-led sections, short field notes, expert quotes, and a closing outlook on how local manufacturing changes cities. Make it feel like a premium design magazine feature.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d85179d8-7f58-4c1f-9f05-217f4fc3efec/hosted-desktop.png",
    artifactUrl:
      "https://gallery-trial-article-editorial-editorial-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:web-prototype-taste-editorial",
    designSystemId: "od:design-system:editorial",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:web-prototype-taste-editorial",
      "od:design-system:editorial",
    ],
  },
  {
    slug: "neighborhood-roasters",
    category: "website",
    title: "Neighborhood Roasters",
    description:
      "A warm magazine-style story about independent coffee roasters, with founder profiles, sensory writing, and neighborhood context.",
    prompt:
      "Create a polished magazine-style website about independent coffee roasters rebuilding neighborhood culture. Use warm storytelling, sensory details, founder profiles, a simple map-like section, and a thoughtful conclusion. Make it feel inviting, tactile, and carefully edited.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1a78c132-62e2-4a95-81dc-ac3f7941207d/gallery-trial-article-editorial-warm-hosted.png",
    artifactUrl:
      "https://gallery-trial-article-editorial-warm-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:web-prototype-taste-editorial",
    designSystemId: "od:design-system:warm-editorial",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:web-prototype-taste-editorial",
      "od:design-system:warm-editorial",
    ],
  },
  {
    slug: "travel-camera-setup-guide",
    category: "website",
    title: "Travel Camera Setup Guide",
    description:
      "A premium product guide for travel creators, with comparison cards, setup examples, and buying considerations.",
    prompt:
      "Create a polished website guide to choosing a modern travel camera setup. Structure it like a beautiful product guide with clear sections, comparison cards, practical examples, buying considerations, and a calm premium visual feel. Make it useful for creators who want to travel light.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/31647c3f-1e30-44cc-8a39-41fe627e0d90/hosted-desktop.png",
    artifactUrl:
      "https://gallery-trial-article-docs-apple-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:apple",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:docs-page",
      "od:design-system:apple",
    ],
  },
  {
    slug: "personal-finance-app-launch-brief",
    category: "website",
    title: "Personal Finance App Launch Brief",
    description:
      "A product-led launch brief for a personal finance app, covering target users, promise, trust principles, onboarding, and priorities.",
    prompt:
      "Create a polished website for the launch brief of a personal finance app. Present the target user, product promise, key screens, trust principles, onboarding flow, differentiators, and launch priorities. Make it feel premium, calm, and product-led.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fa2885c1-ff65-4888-b9f7-cb9399ccaa01/hosted-screenshot.png",
    artifactUrl:
      "https://gallery-trial-brief-editorial-apple-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:design-brief",
    templateId: "od:template:web-prototype-taste-editorial",
    designSystemId: "od:design-system:apple",
    resourceHints: [
      "od:skill:design-brief",
      "od:template:web-prototype-taste-editorial",
      "od:design-system:apple",
    ],
  },
  {
    slug: "developer-sdk-design-brief",
    category: "website",
    title: "Developer SDK Design Brief",
    description:
      "A minimal engineering handoff brief for a developer SDK, including users, jobs, onboarding, IA, API examples, and open decisions.",
    prompt:
      "Create a polished website design brief for a developer SDK. Explain the target developers, core jobs to be done, onboarding path, information architecture, API examples, quality bar, and open decisions. Make it feel precise, minimal, and useful for an engineering handoff.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b80adf01-17a1-4ddc-8c5f-a4f46da76399/hosted-desktop.png",
    artifactUrl: "https://gallery-trial-brief-docs-mono-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:design-brief",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:mono",
    resourceHints: [
      "od:skill:design-brief",
      "od:template:docs-page",
      "od:design-system:mono",
    ],
  },
  {
    slug: "support-ops-redesign-brief",
    category: "website",
    title: "Support Ops Redesign Brief",
    description:
      "A practical support operations dashboard brief with pain points, triage, automation opportunities, metrics, rollout, and decisions.",
    prompt:
      "Create a polished website for a support operations redesign brief. Show the current pain points, workflow principles, triage model, automation opportunities, quality metrics, rollout plan, and decision log. Make it feel like a practical dashboard for support and product leaders.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a4f821f8-474f-4200-b1dc-30c91263a166/screenshot.png",
    artifactUrl:
      "https://gallery-trial-brief-dashboard-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:design-brief",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:dashboard",
    resourceHints: [
      "od:skill:design-brief",
      "od:template:dashboard",
      "od:design-system:dashboard",
    ],
  },
];

export function buildGalleryPromptHref(
  item: GalleryItem,
  locale: string,
): string {
  const url = new URL(`/${locale}/showcase`, "https://www.vm0.ai");
  const hintText =
    item.resourceHints && item.resourceHints.length > 0
      ? `\n\nResource hints: ${item.resourceHints.join(", ")}`
      : "";

  url.searchParams.set(
    "prompt",
    item.artifactUrl ? item.prompt : `${item.prompt}${hintText}`,
  );
  if (item.artifactUrl) {
    url.searchParams.set("website", item.artifactUrl);
  }
  return `${url.pathname}${url.search}`;
}
