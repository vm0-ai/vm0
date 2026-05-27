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
      "Using `zero generate website` with design system `dashboard` and template `dashboard`, create a polished website for a SaaS launch metrics command center. Show activation, retention, revenue, support load, release health, ranked opportunities, and a concise executive summary. Make it feel like a quiet operational dashboard that a founder could scan every morning.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/751a6c2a-cd82-4322-86a4-dc1a1b9ab7a3/gallery-trial-data-dashboard-dashboard-hosted.png",
    artifactUrl:
      "https://gallery-trial-data-dashboard-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:dashboard",
    resourceHints: [
      "od:skill:frontend-design",
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
      "Using `zero generate website` with design system `trading-terminal` and template `dashboard`, create a polished website for a real-time market risk monitor. Show liquidity, volatility, exposure, alerts, watchlists, and a concise risk summary for an investment team. Make it feel like a dark, high-density trading terminal with clear charts and fast scanning.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/57d4059d-a65e-4807-b21a-a6f6ae1b4f57/gallery-trial-data-dashboard-terminal-hosted.png",
    artifactUrl:
      "https://gallery-trial-data-dashboard-terminal-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:trading-terminal",
    resourceHints: [
      "od:skill:frontend-design",
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
      "Using `zero generate website` with design system `dashboard` and template `finance-report`, create a polished executive website report about AI infrastructure cost efficiency. Include spend trends, unit economics, gross margin pressure, vendor concentration, optimization opportunities, risks, and a clear recommendation section. Make it feel like a rigorous board-ready report with practical charts and tables.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d35e7d77-fb4f-42f7-a9c9-c41282e0c7f5/hosted-screenshot.png",
    artifactUrl:
      "https://gallery-trial-data-finance-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:finance-report",
    designSystemId: "od:design-system:dashboard",
    resourceHints: [
      "od:skill:frontend-design",
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
      "Using `zero generate website` with design system `mono` and template `docs-page`, create a polished website that documents API usage analytics for a developer platform. Include metric definitions, event taxonomy, query examples, dashboard interpretation, anomaly notes, and a concise data quality checklist. Make it feel precise, minimal, and technical without becoming cluttered.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d1f09f14-f861-4a79-9a40-794b11e04e12/hosted-screenshot-visible.png",
    artifactUrl: "https://gallery-trial-data-docs-mono-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:mono",
    resourceHints: [
      "od:skill:frontend-skill",
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
      "Using `zero generate website` with design system `editorial` and template `web-prototype-taste-editorial`, create a polished editorial website feature about the rise of urban microfactories. Tell the story through strong headlines, image-led sections, short field notes, expert quotes, and a closing outlook on how local manufacturing changes cities. Make it feel like a premium design magazine feature.",
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
      "Using `zero generate website` with design system `warm-editorial` and template `web-prototype-taste-editorial`, create a polished magazine-style website about independent coffee roasters rebuilding neighborhood culture. Use warm storytelling, sensory details, founder profiles, a simple map-like section, and a thoughtful conclusion. Make it feel inviting, tactile, and carefully edited.",
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
      "Using `zero generate website` with design system `apple` and template `docs-page`, create a polished website guide to choosing a modern travel camera setup. Structure it like a beautiful product guide with clear sections, comparison cards, practical examples, and buying considerations. Make it feel calm and premium, useful for creators who want to travel light.",
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
      "Using `zero generate website` with design system `apple` and template `web-prototype-taste-editorial`, create a polished website for the launch brief of a personal finance app. Present the target user, product promise, key screens, trust principles, onboarding flow, differentiators, and launch priorities. Make it feel premium, calm, and product-led.",
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
      "Using `zero generate website` with design system `mono` and template `docs-page`, create a polished website design brief for a developer SDK. Explain the target developers, core jobs to be done, onboarding path, information architecture, API examples, quality bar, and open decisions. Make it feel precise, minimal, and useful for an engineering handoff.",
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
      "Using `zero generate website` with design system `dashboard` and template `dashboard`, create a polished website for a support operations redesign brief. Show the current pain points, workflow principles, triage model, automation opportunities, quality metrics, rollout plan, and decision log. Make it feel like a practical dashboard for support and product leaders.",
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
  {
    slug: "claude-ai-platform-launch",
    category: "website",
    title: "Claude Platform Launch",
    description:
      "A warm, premium launch page for an AI research assistant, with capabilities, prompt examples, safety principles, and an integration story.",
    prompt:
      "Using `zero generate website` with design system `claude` and template `saas-landing`, create a launch site for an AI research assistant platform built on Claude. Cover the core capability, prompt examples, safety principles, integration paths, and a clear call to start a workspace. Make it feel warm, considered, premium, calm.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/claude-ai-platform-launch.png",
    artifactUrl:
      "https://web-design-pass1-claude-ai-platform-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:claude",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:claude",
    ],
  },
  {
    slug: "openai-api-pricing-tiers",
    category: "website",
    title: "OpenAI API Pricing Tiers",
    description:
      "A precise API pricing comparison across reasoning, multimodal, and fast tiers, with quotas, rate limits, and a side-by-side feature matrix.",
    prompt:
      "Using `zero generate website` with design system `openai` and template `pricing-page`, create a model API pricing page that compares reasoning, multimodal, and fast tiers. Show per-token costs, included quotas, rate limits, batch discounts, enterprise add-ons, and a side-by-side feature matrix. Make it feel precise, confident, monochrome, trustworthy.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/openai-api-pricing-tiers.png",
    artifactUrl:
      "https://web-design-pass1-openai-api-pricing-tiers-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:paywall-upgrade-cro",
    templateId: "od:template:pricing-page",
    designSystemId: "od:design-system:openai",
    resourceHints: [
      "od:skill:paywall-upgrade-cro",
      "od:template:pricing-page",
      "od:design-system:openai",
    ],
  },
  {
    slug: "linear-product-spec",
    category: "website",
    title: "Linear Product Spec",
    description:
      "A dense product spec for a new triage view, with problem, success metrics, scope, key states, rollout, and open questions.",
    prompt:
      "Using `zero generate website` with design system `linear-app` and template `pm-spec`, create a product spec for shipping a new triage view in a project tracker. Cover problem, user, success metrics, scope, out-of-scope, IA, key states, rollout, and open questions. Make it feel precise, dense, keyboard-first, calm grayscale.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/linear-product-spec.png",
    artifactUrl:
      "https://web-design-pass1-linear-product-spec-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:design-brief",
    templateId: "od:template:pm-spec",
    designSystemId: "od:design-system:linear-app",
    resourceHints: [
      "od:skill:design-brief",
      "od:template:pm-spec",
      "od:design-system:linear-app",
    ],
  },
  {
    slug: "vercel-platform-landing",
    category: "website",
    title: "Vercel Platform Landing",
    description:
      "A frontend deployment platform landing with framework grid, preview deploys, edge functions, analytics, and developer testimonials.",
    prompt:
      "Using `zero generate website` with design system `vercel` and template `saas-landing`, create a landing site for a frontend deployment and edge runtime platform. Hero with framework grid, preview deploys, edge functions, analytics, pricing teaser, and developer testimonials. Make it feel sharp typography, mono accents, generous whitespace.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/vercel-platform-landing.png",
    artifactUrl:
      "https://web-design-pass1-vercel-platform-landing-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:web-design-guidelines",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:vercel",
    resourceHints: [
      "od:skill:web-design-guidelines",
      "od:template:saas-landing",
      "od:design-system:vercel",
    ],
  },
  {
    slug: "cursor-ide-launch",
    category: "website",
    title: "Cursor IDE Launch",
    description:
      "An AI-native code editor launch with inline-chat workflow, tab-tab completion, codebase indexing, and model picker.",
    prompt:
      "Using `zero generate website` with design system `cursor` and template `saas-landing`, create a launch site for an AI-native code editor. Show inline-chat workflow, tab-tab completion, codebase indexing, model picker, keyboard shortcuts, and a download CTA. Make it feel dark editor aesthetic, vivid syntax highlights, fast and minimal.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/cursor-ide-launch.png",
    artifactUrl:
      "https://web-design-pass1-cursor-ide-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:cursor",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:cursor",
    ],
  },
  {
    slug: "github-repo-dashboard",
    category: "website",
    title: "GitHub Repo Insights",
    description:
      "A repository insights dashboard with PR queue, stale issues, top contributors, release cadence, and a health summary.",
    prompt:
      "Using `zero generate website` with design system `github` and template `github-dashboard`, create a repository insights dashboard with PRs, issues, releases, and contributors. Include activity sparkline, open PR queue, stale issues, top contributors this month, release cadence, and a health summary. Make it feel GitHub octicon language, dense rows, restrained color.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/github-repo-dashboard.png",
    artifactUrl:
      "https://web-design-pass1-github-repo-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:github-dashboard",
    designSystemId: "od:design-system:github",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:github-dashboard",
      "od:design-system:github",
    ],
  },
  {
    slug: "supabase-developer-docs",
    category: "website",
    title: "Supabase Developer Docs",
    description:
      "A developer docs page for auth and row-level security with code-forward examples in SQL and JavaScript.",
    prompt:
      "Using `zero generate website` with design system `supabase` and template `docs-page`, create a docs page for the auth + row-level-security primitives. Include a left nav, body with code blocks (SQL + JS), inline warning callouts, table of contents, and a previous/next footer. Make it feel readable serif headers, green accents, code-forward.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/supabase-developer-docs.png",
    artifactUrl:
      "https://web-design-pass1-supabase-developer-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:supabase",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:supabase",
    ],
  },
  {
    slug: "mintlify-api-reference",
    category: "website",
    title: "Mintlify API Reference",
    description:
      "An airy API reference page for a transcription endpoint, with request/response schemas, code samples, and a try-it panel.",
    prompt:
      "Using `zero generate website` with design system `mintlify` and template `docs-page`, create an API reference page for a transcription endpoint. Include endpoint signature, request/response schemas, code samples in cURL/Python/JS, error table, and a try-it panel. Make it feel airy, gradient accents, friendly developer feel.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/mintlify-api-reference.png",
    artifactUrl:
      "https://web-design-pass1-mintlify-api-reference-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:mintlify",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:mintlify",
    ],
  },
  {
    slug: "raycast-extensions-launch",
    category: "website",
    title: "Raycast Extensions Launch",
    description:
      "A launch page for a Raycast extensions marketplace with a command-palette mockup, featured extensions, and a developer kit teaser.",
    prompt:
      "Using `zero generate website` with design system `raycast` and template `saas-landing`, create a launch page for a Raycast extensions marketplace category. Hero command palette mockup, featured extensions, install flow, developer kit teaser, and a closing CTA. Make it feel punchy red accent, dark UI, hotkey-driven.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/raycast-extensions-launch.png",
    artifactUrl:
      "https://web-design-pass1-raycast-extensions-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:raycast",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:raycast",
    ],
  },
  {
    slug: "posthog-product-analytics",
    category: "website",
    title: "PostHog Product Analytics",
    description:
      "A product analytics dashboard with DAU/WAU, feature adoption funnel, retention heatmap, and a session replay teaser.",
    prompt:
      "Using `zero generate website` with design system `posthog` and template `dashboard`, create a product analytics dashboard for activation, retention, and feature usage. Show DAU/WAU, feature adoption funnel, retention heatmap, session replay teaser, and a top-events table. Make it feel playful but data-dense, hedgehog energy without being cute.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/posthog-product-analytics.png",
    artifactUrl:
      "https://web-design-pass1-posthog-product-analytics-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:posthog",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:posthog",
    ],
  },
  {
    slug: "notion-team-wiki",
    category: "website",
    title: "Notion Team Wiki",
    description:
      "A team wiki entry documenting an engineering on-call rotation, with escalation policy, runbook links, and recent retros.",
    prompt:
      "Using `zero generate website` with design system `notion` and template `blog-post`, create a team wiki entry that documents an engineering on-call rotation. Include intro callout, escalation policy, runbook links, schedule embed, and recent incident retros. Make it feel clean serif, generous spacing, page emoji headers.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/notion-team-wiki.png",
    artifactUrl:
      "https://web-design-pass1-notion-team-wiki-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:notion",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:notion",
    ],
  },
  {
    slug: "stripe-payments-pricing",
    category: "website",
    title: "Stripe Payments Pricing",
    description:
      "A Stripe-style payments pricing page with per-transaction fees, an interactive fee calculator, FAQs, and an enterprise CTA.",
    prompt:
      "Using `zero generate website` with design system `stripe` and template `pricing-page`, create a Stripe-style payments pricing page with per-transaction fees and add-ons. Cover standard, custom, and platform tiers, plus an interactive fee calculator section, FAQs, and enterprise contact CTA. Make it feel iconic gradient hero, crisp typography, trustworthy.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/stripe-payments-pricing.png",
    artifactUrl:
      "https://web-design-pass1-stripe-payments-pricing-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:paywall-upgrade-cro",
    templateId: "od:template:pricing-page",
    designSystemId: "od:design-system:stripe",
    resourceHints: [
      "od:skill:paywall-upgrade-cro",
      "od:template:pricing-page",
      "od:design-system:stripe",
    ],
  },
  {
    slug: "figma-design-tool-launch",
    category: "website",
    title: "Figma Design Tool Launch",
    description:
      "A launch page for a Figma-to-React plugin with install flow, before/after demo, supported components, and partner logos.",
    prompt:
      "Using `zero generate website` with design system `figma` and template `saas-landing`, create a launch page for a new Figma plugin that turns frames into production React. Show install flow, before/after demo, supported components, team plan pricing teaser, and partner logos. Make it feel bright multi-color brand, layered shapes, clear hierarchy.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/figma-design-tool-launch.png",
    artifactUrl:
      "https://web-design-pass1-figma-design-tool-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:figma",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:figma",
    ],
  },
  {
    slug: "airbnb-stays-marketplace",
    category: "website",
    title: "Airbnb Stays Marketplace",
    description:
      "A curated long-term-stay marketplace landing with hero search, featured cities, host stories, and trust badges.",
    prompt:
      "Using `zero generate website` with design system `airbnb` and template `saas-landing`, create a curated landing for a long-term-stay travel marketplace. Include hero search, featured cities, host stories, trust badges, and a closing CTA to list a home. Make it feel rounded, photographic, warm coral accent.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/airbnb-stays-marketplace.png",
    artifactUrl:
      "https://web-design-pass1-airbnb-stays-marketplace-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:airbnb",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:airbnb",
    ],
  },
  {
    slug: "slack-team-comms-landing",
    category: "website",
    title: "Slack Team Comms Landing",
    description:
      "A team communications launch with channel mockups, workflow builder preview, huddles use cases, and enterprise security.",
    prompt:
      "Using `zero generate website` with design system `slack` and template `saas-landing`, create a launch site for a new huddles + workflows release. Show channel mockups, workflow builder preview, huddles use cases, enterprise security, and team pricing. Make it feel playful aubergine palette, friendly bubbles, work-first.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/slack-team-comms-landing.png",
    artifactUrl:
      "https://web-design-pass1-slack-team-comms-landing-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:slack",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:slack",
    ],
  },
  {
    slug: "framer-website-builder",
    category: "website",
    title: "Framer Website Builder",
    description:
      "A motion-rich marketing site for a no-code website builder, with template gallery, animation toolkit, and CMS.",
    prompt:
      "Using `zero generate website` with design system `framer` and template `saas-landing`, create a marketing site for a no-code website builder aimed at design teams. Hero animation, template gallery, animation toolkit, CMS, publishing flow, and pricing. Make it feel motion-rich, bold gradient hero, designer-coded feel.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/framer-website-builder.png",
    artifactUrl:
      "https://web-design-pass1-framer-website-builder-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:framer",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:framer",
    ],
  },
  {
    slug: "canva-brand-kit-launch",
    category: "website",
    title: "Canva Brand Kit Launch",
    description:
      "A team brand-kit feature launch with kit setup, asset library, AI generator, team approvals, and pricing tiers.",
    prompt:
      "Using `zero generate website` with design system `canva` and template `saas-landing`, create a launch site for a team brand-kit feature inside a creative platform. Show kit setup, asset library, AI generator, team approvals, and pricing tiers. Make it feel vivid purple gradient, playful illustration, friendly.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/canva-brand-kit-launch.png",
    artifactUrl:
      "https://web-design-pass1-canva-brand-kit-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:canva",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:canva",
    ],
  },
  {
    slug: "intercom-support-launch",
    category: "website",
    title: "Intercom Fin AI Launch",
    description:
      "An AI customer support agent launch with deflection rate, citations, supported channels, and a self-serve setup CTA.",
    prompt:
      "Using `zero generate website` with design system `intercom` and template `saas-landing`, create a launch site for an AI customer support agent built on top of Intercom. Cover deflection rate, handoff to human, sources/citations, supported channels, and a self-serve setup CTA. Make it feel blue/black brand, conversational mockups, calm and capable.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/intercom-support-launch.png",
    artifactUrl:
      "https://web-design-pass1-intercom-support-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:intercom",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:intercom",
    ],
  },
  {
    slug: "apple-product-launch",
    category: "website",
    title: "Apple Product Launch",
    description:
      "A cinematic launch for a wearable health device with floating product render, sensor breakdown, and a configurator CTA.",
    prompt:
      "Using `zero generate website` with design system `apple` and template `saas-landing`, create a launch site for a new wearable health device. Hero with floating product render, capability sections, sensor breakdown, sustainability note, and a configurator CTA. Make it feel cinematic, monochrome, generous whitespace, premium.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/apple-product-launch.png",
    artifactUrl:
      "https://web-design-pass1-apple-product-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:apple-hig",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:apple",
    resourceHints: [
      "od:skill:apple-hig",
      "od:template:saas-landing",
      "od:design-system:apple",
    ],
  },
  {
    slug: "tesla-energy-launch",
    category: "website",
    title: "Tesla Energy Launch",
    description:
      "A launch for a home energy storage product with daily savings chart, install timeline, app integration, and reserve CTA.",
    prompt:
      "Using `zero generate website` with design system `tesla` and template `saas-landing`, create a launch site for a home energy storage product. Hero with product silhouette, daily energy savings chart, install timeline, app integration, and reserve CTA. Make it feel black/white, sharp typography, futuristic minimalism.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/tesla-energy-launch.png",
    artifactUrl:
      "https://web-design-pass1-tesla-energy-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:tesla",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:tesla",
    ],
  },
  {
    slug: "nike-running-launch",
    category: "website",
    title: "Nike Running Launch",
    description:
      "A flagship running shoe launch with editorial photography, athlete story, tech breakdown, and color picker.",
    prompt:
      "Using `zero generate website` with design system `nike` and template `saas-landing`, create a launch site for a flagship running shoe with adaptive cushioning. Hero with editorial photography, athlete story, tech breakdown, color picker, and pre-order CTA. Make it feel bold all-caps, high-contrast, athletic energy.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/nike-running-launch.png",
    artifactUrl:
      "https://web-design-pass1-nike-running-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:nike",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:nike",
    ],
  },
  {
    slug: "spotify-music-landing",
    category: "website",
    title: "Spotify Music Landing",
    description:
      "A curated genre takeover landing with editorial hero, artist spotlight, playlist embeds, and a behind-the-scenes story.",
    prompt:
      "Using `zero generate website` with design system `spotify` and template `saas-landing`, create a landing page for a curated genre takeover. Editorial hero, artist spotlight, playlist embeds, behind-the-scenes story, and a listen CTA. Make it feel black + vivid green, glossy album art tiles, energetic.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/spotify-music-landing.png",
    artifactUrl:
      "https://web-design-pass1-spotify-music-landing-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:spotify",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:spotify",
    ],
  },
  {
    slug: "discord-community-launch",
    category: "website",
    title: "Discord Community Launch",
    description:
      "A verified community server template launch for indie game devs, with channel mockup, role system, and voice stages.",
    prompt:
      "Using `zero generate website` with design system `discord` and template `saas-landing`, create a landing for a verified community server template for indie game devs. Hero with channel mockup, role system, voice stages, moderation tools, and a join CTA. Make it feel blurple gradient, playful illustration, gamer-friendly.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/discord-community-launch.png",
    artifactUrl:
      "https://web-design-pass1-discord-community-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:discord",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:discord",
    ],
  },
  {
    slug: "meta-platform-update",
    category: "website",
    title: "Meta Platform Update",
    description:
      "A quarterly platform update with release highlights, three feature deep-dives, developer changelog, and roadmap teaser.",
    prompt:
      "Using `zero generate website` with design system `meta` and template `saas-landing`, create a quarterly product update site for an open social graph platform. Hero with release highlights, three feature deep-dives, developer changelog, and roadmap teaser. Make it feel modernist blue, large typography, photo-led.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/meta-platform-update.png",
    artifactUrl:
      "https://web-design-pass1-meta-platform-update-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:meta",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:meta",
    ],
  },
  {
    slug: "coinbase-portfolio-dashboard",
    category: "website",
    title: "Coinbase Portfolio",
    description:
      "A personal crypto portfolio dashboard with total value, 24h change, top movers, allocation chart, and recent transactions.",
    prompt:
      "Using `zero generate website` with design system `coinbase` and template `dashboard`, create a personal crypto portfolio dashboard with P&L, holdings, and recent activity. Show total value, 24h change, top movers, allocation chart, recent transactions, and watchlist. Make it feel cobalt blue, calm trust signals, clean rows.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/coinbase-portfolio-dashboard.png",
    artifactUrl:
      "https://web-design-pass1-coinbase-portfolio-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:coinbase",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:coinbase",
    ],
  },
  {
    slug: "binance-trading-terminal",
    category: "website",
    title: "Binance Trading Terminal",
    description:
      "A dense exchange trading terminal with order book, depth chart, candlesticks, open positions, and watchlist sidebar.",
    prompt:
      "Using `zero generate website` with design system `binance` and template `trading-analysis-dashboard-template`, create a dense trading terminal for a major exchange. Order book, depth chart, candlestick chart, open positions, recent fills, and watchlist sidebar. Make it feel dark, amber accent, ticker-dense, high-information.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/binance-trading-terminal.png",
    artifactUrl:
      "https://web-design-pass1-binance-trading-terminal-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:trading-analysis-dashboard-template",
    designSystemId: "od:design-system:binance",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:trading-analysis-dashboard-template",
      "od:design-system:binance",
    ],
  },
  {
    slug: "revolut-card-launch",
    category: "website",
    title: "Revolut Card Launch",
    description:
      "A premium metal travel card launch with card render, FX savings calculator, lounge perks, and order CTA.",
    prompt:
      "Using `zero generate website` with design system `revolut` and template `saas-landing`, create a launch site for a premium metal travel card. Hero with card render, FX savings calculator, lounge perks, security, and order CTA. Make it feel dark luxe, neon accents, fintech polish.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/revolut-card-launch.png",
    artifactUrl:
      "https://web-design-pass1-revolut-card-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:revolut",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:revolut",
    ],
  },
  {
    slug: "glassmorphism-saas-launch",
    category: "website",
    title: "Glassmorphism Cloud Launch",
    description:
      "A creator cloud storage launch with frosted hero panels, floating cards over a vivid gradient, and an integrations grid.",
    prompt:
      "Using `zero generate website` with design system `glassmorphism` and template `saas-landing`, create a launch site for a creator cloud storage product. Frosted hero panels, floating cards over a vivid gradient, pricing trio, and integrations grid. Make it feel vibrant gradient backdrop, blurred glass surfaces, light and airy.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/glassmorphism-saas-launch.png",
    artifactUrl:
      "https://web-design-pass1-glassmorphism-saas-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:glassmorphism",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:glassmorphism",
    ],
  },
  {
    slug: "neobrutalism-todo-launch",
    category: "website",
    title: "Neobrutalism Todo Launch",
    description:
      "An opinionated to-do app marketing site with hard-shadow sticker cards, screenshot strip, and a punchy pricing block.",
    prompt:
      "Using `zero generate website` with design system `neobrutalism` and template `web-prototype-taste-brutalist`, create a marketing site for an opinionated to-do app. Loud headline, sticker-like cards with hard shadows, screenshot strip, and a punchy pricing block. Make it feel thick borders, hard offset shadows, primary colors, playful.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/neobrutalism-todo-launch.png",
    artifactUrl:
      "https://web-design-pass1-neobrutalism-todo-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:web-prototype-taste-brutalist",
    designSystemId: "od:design-system:neobrutalism",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:web-prototype-taste-brutalist",
      "od:design-system:neobrutalism",
    ],
  },
  {
    slug: "neumorphism-music-controls",
    category: "website",
    title: "Neumorphism Music App",
    description:
      "A tactile music control app landing with soft button gallery, preset library, and room calibration.",
    prompt:
      "Using `zero generate website` with design system `neumorphism` and template `saas-landing`, create a landing for a tactile music control app for hi-fi setups. Hero device mockup, soft button gallery, preset library, room calibration, and download CTA. Make it feel soft inset/outset shadows, monochrome, calm and tactile.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/neumorphism-music-controls.png",
    artifactUrl:
      "https://web-design-pass1-neumorphism-music-controls-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:neumorphism",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:neumorphism",
    ],
  },
  {
    slug: "brutalism-zine-launch",
    category: "website",
    title: "Brutalism Indie Zine",
    description:
      "A raw indie design zine launch with issue grid, contributor list, manifesto strip, and a subscribe block.",
    prompt:
      "Using `zero generate website` with design system `brutalism` and template `web-prototype-taste-brutalist`, create a launch site for a quarterly independent design zine. Raw issue grid, contributor list, subscribe block, and a manifesto strip. Make it feel raw type, monospace, no-frills, system fonts allowed.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/brutalism-zine-launch.png",
    artifactUrl:
      "https://web-design-pass1-brutalism-zine-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:web-prototype-taste-brutalist",
    designSystemId: "od:design-system:brutalism",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:web-prototype-taste-brutalist",
      "od:design-system:brutalism",
    ],
  },
  {
    slug: "claymorphism-kids-app",
    category: "website",
    title: "Claymorphism Kids App",
    description:
      "A playful learning app landing for kids with bouncy 3D characters, big play buttons, parent approval, and family plan.",
    prompt:
      "Using `zero generate website` with design system `claymorphism` and template `saas-landing`, create a landing for a learning app for kids. Bouncy 3D characters, big play buttons, parent-approval section, pricing, and family plan. Make it feel rounded clay shapes, soft shadows, playful pastels.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/claymorphism-kids-app.png",
    artifactUrl:
      "https://web-design-pass1-claymorphism-kids-app-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:claymorphism",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:claymorphism",
    ],
  },
  {
    slug: "editorial-design-magazine",
    category: "website",
    title: "Editorial Design Magazine",
    description:
      "A long-form magazine feature on contemporary type design, with hero spread, pull quotes, image-led sections, and footnotes.",
    prompt:
      "Using `zero generate website` with design system `editorial` and template `blog-post`, create a long-form magazine feature on contemporary type design. Hero spread, body with pull quotes, image-led sections, footnotes, and related reading. Make it feel strong serif headlines, premium magazine grid, calm.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/editorial-design-magazine.png",
    artifactUrl:
      "https://web-design-pass1-editorial-design-magazine-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:editorial",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:editorial",
    ],
  },
  {
    slug: "warm-editorial-essay",
    category: "website",
    title: "Warm Editorial Essay",
    description:
      "A warm essay on slow cooking traditions across three cities, with field notes, pull quotes, and a recipe footer.",
    prompt:
      "Using `zero generate website` with design system `warm-editorial` and template `blog-post`, create a warm essay on slow cooking traditions across three cities. Hero photo, intro, three city sections with field notes, pull quotes, and a recipe footer. Make it feel paper background, warm serif, intimate and inviting.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/warm-editorial-essay.png",
    artifactUrl:
      "https://web-design-pass1-warm-editorial-essay-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:warm-editorial",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:warm-editorial",
    ],
  },
  {
    slug: "mono-developer-docs",
    category: "website",
    title: "Mono Developer Docs",
    description:
      "A monochrome documentation page for a Unix-style log CLI, with man-page code blocks, examples, and exit codes.",
    prompt:
      "Using `zero generate website` with design system `mono` and template `docs-page`, create a documentation page for a Unix-style log CLI. Left nav, body with man-page-style code blocks, examples, exit codes, and a 'see also' footer. Make it feel monochrome, monospace, terminal aesthetic, calm.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/mono-developer-docs.png",
    artifactUrl:
      "https://web-design-pass1-mono-developer-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:mono",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:mono",
    ],
  },
  {
    slug: "bento-feature-grid",
    category: "website",
    title: "Bento Feature Grid",
    description:
      "A productivity bundle landing with an asymmetric bento grid of features, mini mockups, testimonials, and pricing.",
    prompt:
      "Using `zero generate website` with design system `bento` and template `saas-landing`, create a landing page for a productivity bundle with a bento-style feature grid. Hero, asymmetric bento grid of 7-9 features with mini mockups, testimonials, and pricing. Make it feel Apple-style rounded tiles, layered depth, light theme.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/bento-feature-grid.png",
    artifactUrl:
      "https://web-design-pass1-bento-feature-grid-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:bento",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:bento",
    ],
  },
  {
    slug: "futuristic-ai-launch",
    category: "website",
    title: "Futuristic AI Launch",
    description:
      "An on-device AI runtime launch with animated grid hero, capability triad, model card, benchmarks, and early-access form.",
    prompt:
      "Using `zero generate website` with design system `futuristic` and template `saas-landing`, create a launch site for a next-gen on-device AI runtime. Hero with animated grid, capability triad, model card, benchmarks, and an early-access form. Make it feel dark neon, holographic accents, sci-fi polish.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/futuristic-ai-launch.png",
    artifactUrl:
      "https://web-design-pass1-futuristic-ai-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:futuristic",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:futuristic",
    ],
  },
  {
    slug: "xiaohongshu-lifestyle-feed",
    category: "website",
    title: "Xiaohongshu Lifestyle Feed",
    description:
      "A creator lifestyle dashboard with top stats, posts grid, trending tags, follower chart, and a draft composer card.",
    prompt:
      "Using `zero generate website` with design system `xiaohongshu` and template `social-media-dashboard`, create a creator-facing lifestyle content dashboard with a Xiaohongshu vibe. Top stats, recent posts grid, trending tags, follower chart, and a draft composer card. Make it feel soft pinks, rounded cards, photogenic, friendly.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/xiaohongshu-lifestyle-feed.png",
    artifactUrl:
      "https://web-design-pass1-xiaohongshu-lifestyle-feed-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:card-xiaohongshu",
    templateId: "od:template:social-media-dashboard",
    designSystemId: "od:design-system:xiaohongshu",
    resourceHints: [
      "od:skill:card-xiaohongshu",
      "od:template:social-media-dashboard",
      "od:design-system:xiaohongshu",
    ],
  },
  {
    slug: "wechat-mini-program-launch",
    category: "website",
    title: "WeChat Mini-Program Launch",
    description:
      "A mini-program launch for small shops with QR mockup, three core flows, merchant testimonials, and a setup CTA.",
    prompt:
      "Using `zero generate website` with design system `wechat` and template `saas-landing`, create a launch page for a mini-program that helps small shops accept orders. Hero with QR mockup, three core flows, merchant testimonials, and a setup CTA. Make it feel green brand, clean cards, super-app polish.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/wechat-mini-program-launch.png",
    artifactUrl:
      "https://web-design-pass1-wechat-mini-program-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:wechat",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:wechat",
    ],
  },
  {
    slug: "theverge-tech-feature",
    category: "website",
    title: "The Verge Tech Feature",
    description:
      "A long-form review of a new pair of AR glasses with bold typography, scored breakdown, photo essay, and a verdict block.",
    prompt:
      "Using `zero generate website` with design system `theverge` and template `blog-post`, create a long-form review of a new pair of AR glasses. Hero with bold typography, scored breakdown, photo essay, hands-on notes, and a verdict block. Make it feel bright magenta accents, energetic type, modern tech magazine.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/theverge-tech-feature.png",
    artifactUrl:
      "https://web-design-pass1-theverge-tech-feature-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:theverge",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:theverge",
    ],
  },
  {
    slug: "retro-synthwave-product",
    category: "website",
    title: "Retro Synthwave Product",
    description:
      "A music-production sample pack launch with neon grid hero, audio waveforms, license tiers, and a download CTA.",
    prompt:
      "Using `zero generate website` with design system `retro` and template `saas-landing`, create a launch page for a music-production sample pack inspired by the 80s. Hero with neon grid, pack contents, audio waveforms, license tiers, and download CTA. Make it feel magenta + cyan, sun-grid horizons, VHS feel.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/retro-synthwave-product.png",
    artifactUrl:
      "https://web-design-pass1-retro-synthwave-product-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:retro",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:retro",
    ],
  },
  {
    slug: "playstation-game-launch",
    category: "website",
    title: "PlayStation Game Launch",
    description:
      "A flagship action-adventure game launch with cinematic hero, trailer placeholder, gameplay pillars, and pre-order CTA.",
    prompt:
      "Using `zero generate website` with design system `playstation` and template `saas-landing`, create a launch site for a flagship action-adventure game. Cinematic hero, story trailer placeholder, gameplay pillars, edition picker, and pre-order CTA. Make it feel dark blue, blade-runner gradient, console-quality polish.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/playstation-game-launch.png",
    artifactUrl:
      "https://web-design-pass1-playstation-game-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:playstation",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:playstation",
    ],
  },
  {
    slug: "pacman-arcade-landing",
    category: "website",
    title: "Pac-Man Arcade Landing",
    description:
      "A browser remake of a classic arcade game with maze hero, play-now CTA, leaderboard, and character roster.",
    prompt:
      "Using `zero generate website` with design system `pacman` and template `gamified-app`, create a landing page for a browser-based remake of a classic arcade game. Hero with maze illustration, play-now CTA, leaderboard, character roster, and history note. Make it feel 8-bit pixel grid, primary colors, joyful.",
    previewImage:
      "https://web-design-pass1-previews-715f6d07.sites.vm0.io/pacman-arcade-landing.png",
    artifactUrl:
      "https://web-design-pass1-pacman-arcade-landing-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:gamified-app",
    designSystemId: "od:design-system:pacman",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:gamified-app",
      "od:design-system:pacman",
    ],
  },
  {
    slug: "airtable-workflow-board",
    category: "website",
    title: "Airtable Workflow Board",
    description:
      "A low-code workflow board with view tabs, grouped records, KPIs, and an automation log.",
    prompt:
      "Using `zero generate website` with design system `airtable` and template `dashboard`, create a low-code workflow board for product launches. Topbar, view tabs, grouped records, sidebar with KPIs, and automation log. Make it feel vibrant brand colors, dense grid, friendly.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/244e183b-74b5-493b-9290-02007772feb4/airtable-workflow-board.png",
    artifactUrl:
      "https://web-design-pass2-airtable-workflow-board-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:airtable",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:airtable",
    ],
  },
  {
    slug: "arc-browser-launch",
    category: "website",
    title: "Arc Browser Launch",
    description:
      "A browser launch page with sidebar mockup, spaces flow, command bar, and AI assist teaser.",
    prompt:
      "Using `zero generate website` with design system `arc` and template `saas-landing`, create a launch site for a browser that organizes tabs into spaces. Hero with sidebar mockup, spaces flow, command bar, AI assist teaser, and download CTA. Make it feel playful gradient, generous whitespace, designer-favorite.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e3d20797-dd13-4c50-b1f9-b02b5b1d2ba0/arc-browser-launch.png",
    artifactUrl:
      "https://web-design-pass2-arc-browser-launch-715f6d07-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:arc",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:arc",
    ],
  },
  {
    slug: "bmw-i7-launch",
    category: "website",
    title: "BMW i7 Launch",
    description:
      "A BMW i7 luxury electric sedan launch with silhouette, range chart, interior tech, and configurator.",
    prompt:
      "Using `zero generate website` with design system `bmw` and template `saas-landing`, create a launch site for the BMW i7 luxury electric sedan. Hero with car silhouette, range chart, interior tech, design language, and configurator CTA. Make it feel navy blue, precise typography, premium German polish.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/acda8ea6-cd1e-41ef-ae72-ece85dafc109/bmw-i7-launch.png",
    artifactUrl: "https://web-design-pass2-bmw-i7-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:bmw",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:bmw",
    ],
  },
  {
    slug: "bugatti-tourbillon-launch",
    category: "website",
    title: "Bugatti Tourbillon Launch",
    description:
      "A Bugatti Tourbillon launch with engineering deep-dive, atelier story, and an allocation request form.",
    prompt:
      "Using `zero generate website` with design system `bugatti` and template `saas-landing`, create a launch site for the Bugatti Tourbillon hyper sports car. Hero with silhouette, engineering deep-dive, atelier story, allocation request form, and concierge contact. Make it feel haute couture, navy and gold, quiet ultra-luxury.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5523f357-9aa1-4a30-9e67-a65d9435ae3c/bugatti-tourbillon-launch.png",
    artifactUrl:
      "https://web-design-pass2-bugatti-tourbillon-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:bugatti",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:bugatti",
    ],
  },
  {
    slug: "cal-scheduling-launch",
    category: "website",
    title: "Cal Scheduling Launch",
    description:
      "A launch site for an open-source scheduling tool with embed mockup, booking flow, and integrations.",
    prompt:
      "Using `zero generate website` with design system `cal` and template `saas-landing`, create a launch site for an open-source scheduling tool. Hero with embed mockup, booking flow, integrations, self-host option, and pricing. Make it feel black and white with electric accent, calm, designer-aware.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5783e7bd-050f-4063-9e76-eed4266feb44/cal-scheduling-launch.png",
    artifactUrl:
      "https://web-design-pass2-cal-scheduling-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:cal",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:cal",
    ],
  },
  {
    slug: "cohere-enterprise-rag",
    category: "website",
    title: "Cohere Enterprise Rag",
    description:
      "An enterprise retrieval-augmented-generation platform launch with embed model, rerank, citations, and on-prem options.",
    prompt:
      "Using `zero generate website` with design system `cohere` and template `saas-landing`, create a launch site for an enterprise retrieval augmented generation platform. Cover embed model, rerank, citations, on-prem options, and a request-access form. Make it feel trustworthy magenta gradients, enterprise polish, careful copy.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f4520473-83d0-4549-9958-b8c6c9e6e2b2/cohere-enterprise-rag.png",
    artifactUrl:
      "https://web-design-pass2-cohere-enterprise-rag-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:cohere",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:cohere",
    ],
  },
  {
    slug: "cosmic-space-sim",
    category: "website",
    title: "Cosmic Space Sim",
    description:
      "A multiplayer space exploration sim landing with star-field, faction picker, and beta sign-up.",
    prompt:
      "Using `zero generate website` with design system `cosmic` and template `saas-landing`, create a landing page for a multiplayer space exploration sim. Hero with star-field, faction picker, ship roster, season roadmap, and beta sign-up CTA. Make it feel deep space gradients, star-field, sci-fi gravitas.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/80d8f73e-3745-450a-9256-89e8c23d241c/cosmic-space-sim.png",
    artifactUrl:
      "https://web-design-pass2-cosmic-space-sim-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:cosmic",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:cosmic",
    ],
  },
  {
    slug: "dithered-indie-launch",
    category: "website",
    title: "Dithered Indie Launch",
    description:
      "An indie pixel-art puzzle game launch with dithered key art, gameplay loop, and a wishlist CTA.",
    prompt:
      "Using `zero generate website` with design system `dithered` and template `web-prototype`, create a launch site for an indie pixel-art puzzle game. Hero with dithered key art, story snippet, gameplay loop, soundtrack snippet, and wishlist CTA. Make it feel 1-bit dithered halftone, monochrome with one accent, retro indie warmth.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c2002d1f-b114-49d5-94c3-56b8bb131fb5/dithered-indie-launch.png",
    artifactUrl:
      "https://web-design-pass2-dithered-indie-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:web-prototype",
    designSystemId: "od:design-system:dithered",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:web-prototype",
      "od:design-system:dithered",
    ],
  },
  {
    slug: "doodle-kids-book",
    category: "website",
    title: "Doodle Kids Book",
    description:
      "A hand-drawn kids storybook subscription landing with character doodles, sample pages, and gift options.",
    prompt:
      "Using `zero generate website` with design system `doodle` and template `saas-landing`, create a landing page for a hand-drawn kids storybook subscription. Hero with character doodle, sample pages, age guide, gift options, and subscribe CTA. Make it feel hand-drawn lines, crayon textures, joyful and warm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/845d1f1b-1d99-47de-ba39-5db21de4a387/doodle-kids-book.png",
    artifactUrl:
      "https://web-design-pass2-doodle-kids-book-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:doodle",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:doodle",
    ],
  },
  {
    slug: "duolingo-language-launch",
    category: "website",
    title: "Duolingo Language Launch",
    description:
      "A daily-streak language learning launch with mascot scene, lesson preview, and leaderboards.",
    prompt:
      "Using `zero generate website` with design system `duolingo` and template `gamified-app`, create a landing page for a new daily-streak language learning experience. Hero with mascot scene, daily streak demo, lesson preview, leaderboards, and family plan. Make it feel green energetic, playful illustrations, encouraging.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6bdd274e-8276-4bfa-a874-ee632edb5b98/duolingo-language-launch.png",
    artifactUrl:
      "https://web-design-pass2-duolingo-language-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:gamified-app",
    designSystemId: "od:design-system:duolingo",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:gamified-app",
      "od:design-system:duolingo",
    ],
  },
  {
    slug: "elevenlabs-voice-launch",
    category: "website",
    title: "Elevenlabs Voice Launch",
    description:
      "A voice cloning launch with sample players, language list, use cases, and a safety policy.",
    prompt:
      "Using `zero generate website` with design system `elevenlabs` and template `saas-landing`, create a launch site for a multilingual voice cloning model. Voice sample player mockups, language list, use cases, safety policy, and pricing. Make it feel purple-black, audio waveform accents, premium.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/69ed89f6-0dd8-4091-bc91-5e5bb78f1a5f/elevenlabs-voice-launch.png",
    artifactUrl:
      "https://web-design-pass2-elevenlabs-voice-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:elevenlabs",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:elevenlabs",
    ],
  },
  {
    slug: "ferrari-296-launch",
    category: "website",
    title: "Ferrari 296 Launch",
    description:
      "A Ferrari 296 GTS hybrid spider launch with silhouette, performance numbers, and book-a-test-drive CTA.",
    prompt:
      "Using `zero generate website` with design system `ferrari` and template `saas-landing`, create a launch site for the Ferrari 296 GTS hybrid spider. Hero with car silhouette, performance numbers, design language, color options, and book a test drive CTA. Make it feel iconic Ferrari red, cinematic photography mood, motorsport heritage.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cb54b837-109b-421f-b94a-77bd54235bd1/ferrari-296-launch.png",
    artifactUrl:
      "https://web-design-pass2-ferrari-296-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:ferrari",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:ferrari",
    ],
  },
  {
    slug: "gradient-fitness-launch",
    category: "website",
    title: "Gradient Fitness Launch",
    description:
      "A personalized fitness app launch with workout mockup, program library, and family plan.",
    prompt:
      "Using `zero generate website` with design system `gradient` and template `saas-landing`, create a launch site for a personalized fitness app. Hero with workout mockup, program library, coach-led plans, family plan, and try-free CTA. Make it feel vivid multi-stop gradients, glossy surfaces, motivating.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/11a78658-38c8-46a8-98ac-abcab12f2e35/gradient-fitness-launch.png",
    artifactUrl:
      "https://web-design-pass2-gradient-fitness-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:gradient",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:gradient",
    ],
  },
  {
    slug: "hashicorp-config-docs",
    category: "website",
    title: "Hashicorp Config Docs",
    description:
      "A docs page for infrastructure-as-code with HCL blocks, resource reference, and provider notes.",
    prompt:
      "Using `zero generate website` with design system `hashicorp` and template `docs-page`, create a docs page for infrastructure-as-code configuration. Left nav, HCL code blocks, resource reference, examples, and provider notes. Make it feel indigo brand, calm and authoritative, ops-team comfort.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fa084835-33b5-444b-9aa8-3e1ee35d7127/hashicorp-config-docs.png",
    artifactUrl:
      "https://web-design-pass2-hashicorp-config-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:hashicorp",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:hashicorp",
    ],
  },
  {
    slug: "huggingface-transformers-docs",
    category: "website",
    title: "Huggingface Transformers Docs",
    description:
      "A transformers pipelines docs page with code blocks, model card embeds, and warnings.",
    prompt:
      "Using `zero generate website` with design system `huggingface` and template `docs-page`, create a docs page for the transformers library pipelines API. Left nav, body with Python code blocks, model card embeds, warnings, and previous/next footer. Make it feel warm yellow accent, friendly developer feel, hub-energy.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b8e4c0a9-12f0-4a24-bcd8-3945fd341df0/huggingface-transformers-docs.png",
    artifactUrl:
      "https://web-design-pass2-huggingface-transformers-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:huggingface",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:huggingface",
    ],
  },
  {
    slug: "ibm-quantum-feature",
    category: "website",
    title: "IBM Quantum Feature",
    description:
      "A long-form research feature about a quantum computing milestone with technical breakdown and quotes.",
    prompt:
      "Using `zero generate website` with design system `ibm` and template `blog-post`, create a long-form research feature about a milestone in quantum computing. Lab story, technical breakdown, illustrations, expert quotes, and what's next section. Make it feel IBM blue, IBM Plex typography, research-paper authority.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bce59822-eb01-422e-bb6f-5de032dffed6/ibm-quantum-feature.png",
    artifactUrl:
      "https://web-design-pass2-ibm-quantum-feature-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:ibm",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:ibm",
    ],
  },
  {
    slug: "kraken-spot-terminal",
    category: "website",
    title: "Kraken Spot Terminal",
    description:
      "A spot trading terminal with order book, depth chart, candlesticks, positions, and fee schedule.",
    prompt:
      "Using `zero generate website` with design system `kraken` and template `trading-analysis-dashboard-template`, create a spot trading terminal with charts and order management. Order book, depth chart, candlestick chart, open positions, and exchange-fee schedule. Make it feel deep purple-black, professional trader feel, dense data.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/028cbb13-eb4a-4e5f-a764-ddb5f8e9535e/kraken-spot-terminal.png",
    artifactUrl:
      "https://web-design-pass2-kraken-spot-terminal-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:trading-analysis-dashboard-template",
    designSystemId: "od:design-system:kraken",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:trading-analysis-dashboard-template",
      "od:design-system:kraken",
    ],
  },
  {
    slug: "lamborghini-revuelto-launch",
    category: "website",
    title: "Lamborghini Revuelto Launch",
    description:
      "A Lamborghini Revuelto V12 plug-in hybrid launch with drive modes, weight chart, and configurator.",
    prompt:
      "Using `zero generate website` with design system `lamborghini` and template `saas-landing`, create a launch site for the Lamborghini Revuelto plug-in hybrid V12. Hero with silhouette, drive modes, weight distribution chart, configurator, and reserve CTA. Make it feel bold yellow + black, angular hexagons, dramatic Italian energy.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d3732ffd-fb9c-4e0b-b5f0-4a1987f93320/lamborghini-revuelto-launch.png",
    artifactUrl:
      "https://web-design-pass2-lamborghini-revuelto-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:lamborghini",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:lamborghini",
    ],
  },
  {
    slug: "loom-async-video-launch",
    category: "website",
    title: "Loom Async Video Launch",
    description:
      "An async video review feature launch with record-and-share demo, threads, and transcripts.",
    prompt:
      "Using `zero generate website` with design system `loom` and template `saas-landing`, create a launch site for an async video review feature. Hero with record-and-share demo, threads, transcript, integrations, and team pricing. Make it feel purple accent, friendly UI mockups, work-first.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a7ec7f11-88d3-4926-b867-b8e7e4ec3fe6/loom-async-video-launch.png",
    artifactUrl:
      "https://web-design-pass2-loom-async-video-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:loom",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:loom",
    ],
  },
  {
    slug: "lovable-vibe-coding-launch",
    category: "website",
    title: "Lovable Vibe Coding Launch",
    description:
      "A chat-to-app builder marketing site with prompt-to-app demo, deploy flow, and templates gallery.",
    prompt:
      "Using `zero generate website` with design system `lovable` and template `saas-landing`, create a marketing site for a chat-to-app builder. Prompt-to-app demo, framework support, deploy flow, templates gallery, and pricing. Make it feel warm gradient, playful illustrations, optimistic.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/888740c7-d540-48a2-9b20-11b3e20dcf53/lovable-vibe-coding-launch.png",
    artifactUrl:
      "https://web-design-pass2-lovable-vibe-coding-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:lovable",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:lovable",
    ],
  },
  {
    slug: "mastercard-corporate-card",
    category: "website",
    title: "Mastercard Corporate Card",
    description:
      "A corporate spend card launch with card render, expense controls, integrations, and security badges.",
    prompt:
      "Using `zero generate website` with design system `mastercard` and template `saas-landing`, create a launch site for a corporate spend card with controls. Hero with card render, expense controls, integrations, security badges, and request demo CTA. Make it feel trustworthy red-orange brand, business polish, dense feature grid.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a22213b9-3022-4d86-8a18-c0ec40f2714f/mastercard-corporate-card.png",
    artifactUrl:
      "https://web-design-pass2-mastercard-corporate-card-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:mastercard",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:mastercard",
    ],
  },
  {
    slug: "material-design-spec",
    category: "website",
    title: "Material Design Spec",
    description:
      "A Material Design 3 component spec page with anatomy, states, motion, and accessibility notes.",
    prompt:
      "Using `zero generate website` with design system `material` and template `docs-page`, create a spec page for a Material Design 3 component. Left nav, anatomy diagram, states table, motion guidance, code snippet, and accessibility notes. Make it feel Material colors, clear hierarchy, spec-paper polish.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0644bf70-445c-4e07-a8a5-c24604d6d003/material-design-spec.png",
    artifactUrl:
      "https://web-design-pass2-material-design-spec-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:platform-design",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:material",
    resourceHints: [
      "od:skill:platform-design",
      "od:template:docs-page",
      "od:design-system:material",
    ],
  },
  {
    slug: "minimax-video-api-launch",
    category: "website",
    title: "Minimax Video API Launch",
    description:
      "A text-to-video API launch with generation examples, prompt tips, latency tiers, and pricing.",
    prompt:
      "Using `zero generate website` with design system `minimax` and template `saas-landing`, create a launch page for a text-to-video API tier. Generation examples, prompt tips, latency/quality tiers, pricing, and try-now panel. Make it feel vivid cinematic accents, dense feature grid, energetic.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6ba5d5a8-e9db-49ce-9f04-01a53eaee37f/minimax-video-api-launch.png",
    artifactUrl:
      "https://web-design-pass2-minimax-video-api-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:minimax",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:minimax",
    ],
  },
  {
    slug: "miro-canvas-launch",
    category: "website",
    title: "Miro Canvas Launch",
    description:
      "An infinite canvas workspace upgrade landing with sticky-note canvas, templates, and AI clustering.",
    prompt:
      "Using `zero generate website` with design system `miro` and template `saas-landing`, create a landing page for an infinite canvas workspace upgrade. Hero with sticky-note canvas mockup, templates, integrations, AI clustering teaser, and pricing. Make it feel bright multi-color, playful sticker shapes, collaborative.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/de0f116f-853f-4c8b-9bc6-57880e6f2430/miro-canvas-launch.png",
    artifactUrl:
      "https://web-design-pass2-miro-canvas-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:miro",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:miro",
    ],
  },
  {
    slug: "mistral-open-weights-release",
    category: "website",
    title: "Mistral Open Weights Release",
    description:
      "An open-weights MoE model release page with benchmarks, checksums, model card, and a deploy guide.",
    prompt:
      "Using `zero generate website` with design system `mistral-ai` and template `saas-landing`, create a release page for a new open-weights mixture-of-experts model. Show benchmarks, weights checksum, model card, licensing terms, and a deploy guide. Make it feel orange accent, technical and confident, European minimalist.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/114b0339-2c20-42e9-8490-6c6f64aa6e6f/mistral-open-weights-release.png",
    artifactUrl:
      "https://web-design-pass2-mistral-open-weights-release-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:mistral-ai",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:mistral-ai",
    ],
  },
  {
    slug: "mongodb-query-docs",
    category: "website",
    title: "Mongodb Query Docs",
    description:
      "A query operators docs page with shell and JavaScript code blocks, parameter tables, and examples.",
    prompt:
      "Using `zero generate website` with design system `mongodb` and template `docs-page`, create a docs page for query operators in a document database. Left nav, body with shell + JS code blocks, parameter table, examples, and see-also. Make it feel dark leafy green, code-dense, calm authoritative.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8386f22e-42be-401d-954a-e4cdeeb4f06a/mongodb-query-docs.png",
    artifactUrl:
      "https://web-design-pass2-mongodb-query-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:mongodb",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:mongodb",
    ],
  },
  {
    slug: "neon-cyberpunk-launch",
    category: "website",
    title: "Neon Cyberpunk Launch",
    description:
      "A cyberpunk-themed mech-builder game launch with neon city hero, mech roster, and pre-order CTA.",
    prompt:
      "Using `zero generate website` with design system `neon` and template `saas-landing`, create a launch site for a cyberpunk-themed mech-builder game. Hero with neon city, mech roster, season pass, multiplayer modes, and pre-order CTA. Make it feel hot pink + cyan glow, scanlines, cyberpunk grit.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1a33d951-fe4f-4c68-90be-aca52d5f686f/neon-cyberpunk-launch.png",
    artifactUrl:
      "https://web-design-pass2-neon-cyberpunk-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:neon",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:neon",
    ],
  },
  {
    slug: "nvidia-accelerator-launch",
    category: "website",
    title: "Nvidia Accelerator Launch",
    description:
      "A launch for a next-gen AI accelerator chip with performance chart, framework support, and reserve CTA.",
    prompt:
      "Using `zero generate website` with design system `nvidia` and template `saas-landing`, create a launch site for a next-gen AI accelerator chip. Hero with chip render, perf chart, framework support, datacenter use case, and reserve CTA. Make it feel signature green on black, futuristic, performance-led.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0db6f06c-8e83-4c3b-820b-195d0a8d809c/nvidia-accelerator-launch.png",
    artifactUrl:
      "https://web-design-pass2-nvidia-accelerator-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:nvidia",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:nvidia",
    ],
  },
  {
    slug: "ollama-local-llm-docs",
    category: "website",
    title: "Ollama Local LLM Docs",
    description:
      "A docs page for running local LLMs on a laptop with install, model pull, run, and GPU notes.",
    prompt:
      "Using `zero generate website` with design system `ollama` and template `docs-page`, create a docs page for running local LLMs on a laptop. Install, model pull, run command, API reference, and GPU acceleration notes. Make it feel warm cream paper, clean serif, calm and approachable.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/47606ffa-b1fb-4b9f-bfa4-2fd01285a429/ollama-local-llm-docs.png",
    artifactUrl:
      "https://web-design-pass2-ollama-local-llm-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:ollama",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:ollama",
    ],
  },
  {
    slug: "opencode-agent-cli-docs",
    category: "website",
    title: "Opencode Agent CLI Docs",
    description:
      "A docs page for an open-source AI coding agent CLI with install, commands, and providers.",
    prompt:
      "Using `zero generate website` with design system `opencode-ai` and template `docs-page`, create a docs page for an open-source AI coding agent CLI. Install, quick-start, command reference, model providers, and contributing. Make it feel terminal-forward, monospace headings, OSS-friendly.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9f5f62b8-05b5-4d91-bd16-0fa781e87499/opencode-agent-cli-docs.png",
    artifactUrl:
      "https://web-design-pass2-opencode-agent-cli-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:opencode-ai",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:opencode-ai",
    ],
  },
  {
    slug: "paper-zine-launch",
    category: "website",
    title: "Paper Zine Launch",
    description:
      "A paper-textured zine feature about urban sketching with artist profiles and a recommended-supplies sidebar.",
    prompt:
      "Using `zero generate website` with design system `paper` and template `blog-post`, create a paper-textured zine feature about urban sketching. Hero spread, three artist profiles with field notes, pull quotes, and a recommended-supplies sidebar. Make it feel paper background, hand-drawn flourishes, quiet personal essay.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d05c4933-3e02-44d3-b36a-cba7a84664c4/paper-zine-launch.png",
    artifactUrl:
      "https://web-design-pass2-paper-zine-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:paper",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:paper",
    ],
  },
  {
    slug: "perplexity-research-assistant",
    category: "website",
    title: "Perplexity Research Assistant",
    description:
      "A research assistant landing with cited answers, source panel, focus modes, and a mobile app teaser.",
    prompt:
      "Using `zero generate website` with design system `perplexity` and template `saas-landing`, create a landing page for a personal research assistant with cited answers. Demo of cited answer, sources panel, focus modes, mobile app teaser, pricing teaser. Make it feel calm teal accents, source-led trust, modern serif headlines.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/81f65e0e-834c-43e3-bc82-5a1d3ec4a1fe/perplexity-research-assistant.png",
    artifactUrl:
      "https://web-design-pass2-perplexity-research-assistant-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:perplexity",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:perplexity",
    ],
  },
  {
    slug: "renault-5-launch",
    category: "website",
    title: "Renault 5 Launch",
    description:
      "A Renault 5 E-Tech retro electric launch with trims, range, charging map, and configurator.",
    prompt:
      "Using `zero generate website` with design system `renault` and template `saas-landing`, create a launch site for the Renault 5 E-Tech electric retro hatchback. Hero with car silhouette, trims, range, charging map, configurator, and order CTA. Make it feel cheerful yellow + black, retro nostalgia with modern polish.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0e3437c8-c66a-48bc-9cb0-b0a3bc6ea164/renault-5-launch.png",
    artifactUrl:
      "https://web-design-pass2-renault-5-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:renault",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:renault",
    ],
  },
  {
    slug: "replicate-model-api-docs",
    category: "website",
    title: "Replicate Model API Docs",
    description:
      "A predictions API docs page with cURL/Python examples, schema, webhooks, and pricing notes.",
    prompt:
      "Using `zero generate website` with design system `replicate` and template `docs-page`, create a docs page for the predictions API of a hosted model. Endpoint signature, cURL/Python examples, schema, webhooks, and pricing notes. Make it feel muted serif headers, code-forward, science-paper vibe.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/761a37eb-736c-4af3-bbb8-af74e482dd8a/replicate-model-api-docs.png",
    artifactUrl:
      "https://web-design-pass2-replicate-model-api-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:replicate",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:replicate",
    ],
  },
  {
    slug: "resend-email-api-pricing",
    category: "website",
    title: "Resend Email API Pricing",
    description:
      "A pricing page for a developer-first transactional email API with tiers, overages, and FAQ.",
    prompt:
      "Using `zero generate website` with design system `resend` and template `pricing-page`, create a pricing page for a developer-first transactional email API. Free/Pro/Enterprise tiers, per-email overages, deliverability features, and FAQ. Make it feel all-black with subtle accents, geometric, developer-first.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/142b513b-4552-4dd4-b626-340dbfeafa6b/resend-email-api-pricing.png",
    artifactUrl:
      "https://web-design-pass2-resend-email-api-pricing-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:paywall-upgrade-cro",
    templateId: "od:template:pricing-page",
    designSystemId: "od:design-system:resend",
    resourceHints: [
      "od:skill:paywall-upgrade-cro",
      "od:template:pricing-page",
      "od:design-system:resend",
    ],
  },
  {
    slug: "runwayml-video-launch",
    category: "website",
    title: "Runwayml Video Launch",
    description:
      "A video-model launch with frame grid hero, capability strip, before/after, and license tiers.",
    prompt:
      "Using `zero generate website` with design system `runwayml` and template `saas-landing`, create a launch site for a new video model with motion brush. Hero with frame grid, capability strip, before/after, license tiers, and try-now CTA. Make it feel cinematic dark, glossy gradients, creative-tool polish.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0283f10e-91de-4741-b158-6d56b3e24922/runwayml-video-launch.png",
    artifactUrl:
      "https://web-design-pass2-runwayml-video-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:runwayml",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:runwayml",
    ],
  },
  {
    slug: "sanity-cms-schema-docs",
    category: "website",
    title: "Sanity CMS Schema Docs",
    description:
      "A content schema docs page with TypeScript examples, field type table, and best practices.",
    prompt:
      "Using `zero generate website` with design system `sanity` and template `docs-page`, create a docs page for content schema and types in a headless CMS. Left nav, body with TypeScript schema examples, field types table, and best practices. Make it feel red accent on white, sharp typography, content-creator friendly.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a3912992-64b2-4291-8d5b-d932040c6554/sanity-cms-schema-docs.png",
    artifactUrl:
      "https://web-design-pass2-sanity-cms-schema-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:sanity",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:sanity",
    ],
  },
  {
    slug: "sentry-error-dashboard",
    category: "website",
    title: "Sentry Error Dashboard",
    description:
      "A real-time error tracking dashboard with frequency chart, issues list, and release health.",
    prompt:
      "Using `zero generate website` with design system `sentry` and template `dashboard`, create a real-time error tracking dashboard for a SaaS app. Top stats, frequency chart, issue list with stack trace preview, release health, and team filter. Make it feel purple-black, dense error rows, ops-team feel.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f399c066-5f8c-42cb-9c45-0412d5ee3e58/sentry-error-dashboard.png",
    artifactUrl:
      "https://web-design-pass2-sentry-error-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:sentry",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:sentry",
    ],
  },
  {
    slug: "shadcn-ui-component-docs",
    category: "website",
    title: "Shadcn UI Component Docs",
    description:
      "A copy-paste UI component library docs page with CLI install, anatomy, and API reference.",
    prompt:
      "Using `zero generate website` with design system `shadcn` and template `docs-page`, create a docs page for a copy-paste UI component library. Install via CLI, anatomy diagram, live preview, code block, and API reference. Make it feel zinc/neutral, sharp typography, copy-friendly.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ec234391-f149-44ea-b312-e4cc735fcc24/shadcn-ui-component-docs.png",
    artifactUrl:
      "https://web-design-pass2-shadcn-ui-component-docs-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:shadcn",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:shadcn",
    ],
  },
  {
    slug: "skeumorphism-music-app",
    category: "website",
    title: "Skeumorphism Music App",
    description:
      "A skeuomorphic synth/DAW app landing with brushed-metal controls, preset library, and mixer mockup.",
    prompt:
      "Using `zero generate website` with design system `skeumorphism` and template `saas-landing`, create a landing page for a skeuomorphic synth/DAW app. Hero with wood-grain device mockup, brushed-metal controls, preset library, mixer mockup, and download CTA. Make it feel brushed metal + leather + wood, photoreal textures, retro studio vibe.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/380d5854-b943-472a-b7de-8613ccb837ad/skeumorphism-music-app.png",
    artifactUrl:
      "https://web-design-pass2-skeumorphism-music-app-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:skeumorphism",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:skeumorphism",
    ],
  },
  {
    slug: "superhuman-email-launch",
    category: "website",
    title: "Superhuman Email Launch",
    description:
      "An ultra-fast email client launch with inbox mockup, AI triage, keyboard reference, and waitlist.",
    prompt:
      "Using `zero generate website` with design system `superhuman` and template `saas-landing`, create a launch site for an ultra-fast email client with shortcuts. Hero with inbox mockup, AI triage, keyboard reference, calendar split, and waitlist CTA. Make it feel premium navy, generous whitespace, status-symbol calm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9ced6db1-ef93-49a6-aeac-89a53bf61eae/superhuman-email-launch.png",
    artifactUrl:
      "https://web-design-pass2-superhuman-email-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:superhuman",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:superhuman",
    ],
  },
  {
    slug: "tetris-remix-launch",
    category: "website",
    title: "Tetris Remix Launch",
    description:
      "A browser tetris remix landing with daily challenge, leaderboard, character skins, and play-now CTA.",
    prompt:
      "Using `zero generate website` with design system `tetris` and template `gamified-app`, create a landing page for a browser-based tetris remix with seasonal challenges. Hero with falling-block grid, daily challenge, leaderboard, character skins, and play-now CTA. Make it feel bold primary blocks, joyful arcade energy, retro polish.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7c591ac0-8dd8-492f-9ab2-f941cbc25daa/tetris-remix-launch.png",
    artifactUrl:
      "https://web-design-pass2-tetris-remix-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:gamified-app",
    designSystemId: "od:design-system:tetris",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:gamified-app",
      "od:design-system:tetris",
    ],
  },
  {
    slug: "together-ai-inference-pricing",
    category: "website",
    title: "Together AI Inference Pricing",
    description:
      "An open-source model serving pricing page with per-token tables, dedicated endpoints, and fine-tune pricing.",
    prompt:
      "Using `zero generate website` with design system `together-ai` and template `pricing-page`, create a pricing page for an open-source model serving platform. Per-token table by model family, dedicated endpoints, fine-tune pricing, and enterprise tier. Make it feel clean blue brand, dense table, builder-friendly.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f0e243d4-9b12-48fc-adcb-39ebd4716530/together-ai-inference-pricing.png",
    artifactUrl:
      "https://web-design-pass2-together-ai-inference-pricing-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:paywall-upgrade-cro",
    templateId: "od:template:pricing-page",
    designSystemId: "od:design-system:together-ai",
    resourceHints: [
      "od:skill:paywall-upgrade-cro",
      "od:template:pricing-page",
      "od:design-system:together-ai",
    ],
  },
  {
    slug: "uber-rider-launch",
    category: "website",
    title: "Uber Rider Launch",
    description:
      "A new rider experience launch with map mockup, ride options, safety features, and business travel.",
    prompt:
      "Using `zero generate website` with design system `uber` and template `saas-landing`, create a launch site for a new rider experience tier. Hero with map mockup, ride options, safety features, business travel, and download CTA. Make it feel signature black, sharp typography, urban energy.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ec2831e1-4bf1-4711-a993-00596dcfddd7/uber-rider-launch.png",
    artifactUrl:
      "https://web-design-pass2-uber-rider-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:uber",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:uber",
    ],
  },
  {
    slug: "urdu-poetry-feature",
    category: "website",
    title: "Urdu Poetry Feature",
    description:
      "A long-form feature on modern Urdu poetry with poet profiles, bilingual couplets, and listening recs.",
    prompt:
      "Using `zero generate website` with design system `urdu` and template `blog-post`, create a long-form feature on modern Urdu poetry. Hero spread, three poet profiles with Urdu+English couplets, pull quotes, and listening recommendations. Make it feel warm parchment, calligraphic flourishes, careful bilingual typography.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/84b0cd64-1ca9-4fa5-a5ad-e4a7847408a4/urdu-poetry-feature.png",
    artifactUrl:
      "https://web-design-pass2-urdu-poetry-feature-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:urdu",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:urdu",
    ],
  },
  {
    slug: "vintage-style-magazine",
    category: "website",
    title: "Vintage Style Magazine",
    description:
      "A magazine feature on the resurgence of vintage typography with pull quotes and image-led sections.",
    prompt:
      "Using `zero generate website` with design system `vintage` and template `blog-post`, create a feature article about the resurgence of vintage typography. Hero spread, body with pull quotes, image-led sections via CSS treatments, and related reading. Make it feel warm sepia, classic serif, slow magazine pacing.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/698f4d9d-40e2-49aa-8c62-d726a3882950/vintage-style-magazine.png",
    artifactUrl:
      "https://web-design-pass2-vintage-style-magazine-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:vintage",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:vintage",
    ],
  },
  {
    slug: "webflow-designer-launch",
    category: "website",
    title: "Webflow Designer Launch",
    description:
      "A no-code visual web designer launch with canvas mockup, components, CMS, and pricing.",
    prompt:
      "Using `zero generate website` with design system `webflow` and template `saas-landing`, create a launch site for a no-code visual web designer. Hero with canvas mockup, components, CMS, hosting, pricing, and partner program teaser. Make it feel indigo brand, layered shadows, design-first.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/72eb3bed-2ec3-48b5-b787-e8c9954f1a52/webflow-designer-launch.png",
    artifactUrl:
      "https://web-design-pass2-webflow-designer-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:webflow",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:webflow",
    ],
  },
  {
    slug: "wise-transfer-launch",
    category: "website",
    title: "Wise Transfer Launch",
    description:
      "A launch site for low-fee international transfers with FX transparency, currencies, and security.",
    prompt:
      "Using `zero generate website` with design system `wise` and template `saas-landing`, create a launch site for low-fee international money transfers. Hero with transfer mockup, FX rate transparency, supported currencies, security, and CTA. Make it feel bright green accent, transparent rates, fintech polish.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3d211d67-3470-452a-87c4-46ddbc16a829/wise-transfer-launch.png",
    artifactUrl:
      "https://web-design-pass2-wise-transfer-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:wise",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:wise",
    ],
  },
  {
    slug: "x-ai-realtime-model-launch",
    category: "website",
    title: "X AI Realtime Model Launch",
    description:
      "A real-time multimodal model launch with latency stats, capability triad, and a waitlist form.",
    prompt:
      "Using `zero generate website` with design system `x-ai` and template `saas-landing`, create a launch site for a real-time multimodal model. Live latency stats, capability triad, x integration, API tiers, and waitlist form. Make it feel stark black, electric edge, unapologetic.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/998c4410-3985-4d81-b57e-b1e842075417/x-ai-realtime-model-launch.png",
    artifactUrl:
      "https://web-design-pass2-x-ai-realtime-model-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:x-ai",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:x-ai",
    ],
  },
  {
    slug: "zapier-automation-launch",
    category: "website",
    title: "Zapier Automation Launch",
    description:
      "A workflow automation launch with workflow canvas, app catalog, AI suggestions, and templates.",
    prompt:
      "Using `zero generate website` with design system `zapier` and template `saas-landing`, create a launch site for a multi-step workflow automation builder. Hero with workflow canvas, app catalog, AI step suggestion, templates, and pricing. Make it feel warm orange, friendly illustrations, builder-oriented.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/58d838ef-13f8-4bb1-8310-e93438298b06/zapier-automation-launch.png",
    artifactUrl:
      "https://web-design-pass2-zapier-automation-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:zapier",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:zapier",
    ],
  },
  {
    slug: "voltagent-agent-runtime",
    category: "website",
    title: "VoltAgent Agent Runtime",
    description:
      "An agent runtime launch with observability, tool calling, workflow state, and deployment controls.",
    prompt:
      "Using `zero generate website` with design system `voltagent` and template `saas-landing`, create a launch site for a production agent runtime. Show agent traces, tool registry, workflow state, deployments, and evaluation gates. Make it feel electric amber, agent-native, technical.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/aec6e934-18f0-4aca-b6bd-502f83272b4a/voltagent-agent-runtime.png",
    artifactUrl:
      "https://web-design-pass3-voltagent-agent-runtime-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:voltagent",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:voltagent",
    ],
  },
  {
    slug: "composio-tool-catalog",
    category: "website",
    title: "Composio Tool Catalog",
    description:
      "A tool integration catalog docs page with auth scopes, actions, trigger recipes, and examples.",
    prompt:
      "Using `zero generate website` with design system `composio` and template `docs-page`, create a docs page for an agent tool integration catalog. Left nav, connector grid, auth scopes, action examples, trigger recipes, and SDK code. Make it feel developer catalog, crisp blue accents, integration-dense.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c6ea7dbd-a4c6-4464-8942-e08adf0ce472/composio-tool-catalog.png",
    artifactUrl:
      "https://web-design-pass3-composio-tool-catalog-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:composio",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:composio",
    ],
  },
  {
    slug: "warp-terminal-workflows",
    category: "website",
    title: "Warp Terminal Workflows",
    description:
      "A modern terminal workflow launch with command blocks, team notebooks, AI fixups, and sharing.",
    prompt:
      "Using `zero generate website` with design system `warp` and template `saas-landing`, create a landing page for a collaborative terminal workflow product. Hero with terminal command blocks, team notebooks, AI fixups, sharing, and install CTA. Make it feel dark terminal polish, neon highlights, fast.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a53c4044-acef-4f4e-89ec-468be7b836ed/warp-terminal-workflows.png",
    artifactUrl:
      "https://web-design-pass3-warp-terminal-workflows-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:warp",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:warp",
    ],
  },
  {
    slug: "expo-router-launch",
    category: "website",
    title: "Expo Router Launch",
    description:
      "A mobile app routing docs page with file-based routes, tabs, native previews, and deployment notes.",
    prompt:
      "Using `zero generate website` with design system `expo` and template `docs-page`, create a docs page for a cross-platform mobile app router. Install, file routes, tabs, native preview, deep links, and deploy notes. Make it feel friendly developer docs, light, mobile-first.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4176a316-a45f-46dc-9d67-e107e2d2c524/expo-router-launch.png",
    artifactUrl:
      "https://web-design-pass3-expo-router-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:expo",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:expo",
    ],
  },
  {
    slug: "clickhouse-observability-dashboard",
    category: "website",
    title: "ClickHouse Observability Dashboard",
    description:
      "A high-throughput observability dashboard with query latency, ingest volume, traces, and alerts.",
    prompt:
      "Using `zero generate website` with design system `clickhouse` and template `dashboard`, create an observability dashboard for high-volume analytics. Top KPIs, latency histogram, ingest chart, trace explorer, and alert queue. Make it feel black and yellow, dense analytics, fast scanning.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d8b506a0-c658-4a64-ab9b-fe1de49dbc79/clickhouse-observability-dashboard.png",
    artifactUrl:
      "https://web-design-pass3-clickhouse-observability-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:clickhouse",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:clickhouse",
    ],
  },
  {
    slug: "mintlify-docs-redesign",
    category: "website",
    title: "Mintlify Docs Redesign",
    description:
      "A polished API docs redesign with quickstart, SDK tabs, endpoint references, and changelog links.",
    prompt:
      "Using `zero generate website` with design system `mintlify` and template `docs-page`, create a docs page for an API platform. Quickstart, SDK tabs, endpoint reference, guides, search, and changelog links. Make it feel mint green, calm documentation, polished.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f842e2d2-9acc-4ce2-9370-2bc59c4f4c18/mintlify-docs-redesign.png",
    artifactUrl:
      "https://web-design-pass3-mintlify-docs-redesign-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:mintlify",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:docs-page",
      "od:design-system:mintlify",
    ],
  },
  {
    slug: "pinterest-trend-board",
    category: "website",
    title: "Pinterest Trend Board",
    description:
      "A visual trend dashboard with pins, audience signals, seasonal boards, and campaign ideas.",
    prompt:
      "Using `zero generate website` with design system `pinterest` and template `dashboard`, create a trend research dashboard for visual campaigns. Masonry board, audience signals, seasonal boards, campaign ideas, and save actions. Make it feel red accent, image-led, editorial.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/25c4e588-a363-42dc-ae01-f23a114ec5f8/pinterest-trend-board.png",
    artifactUrl:
      "https://web-design-pass3-pinterest-trend-board-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:pinterest",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:pinterest",
    ],
  },
  {
    slug: "shopify-storefront-launch",
    category: "website",
    title: "Shopify Storefront Launch",
    description:
      "A storefront launch page with product merchandising, checkout trust, analytics, and fulfillment.",
    prompt:
      "Using `zero generate website` with design system `shopify` and template `saas-landing`, create a landing page for a commerce storefront launch. Product hero, checkout trust, analytics, fulfillment, app ecosystem, and start trial CTA. Make it feel commerce green, practical, merchant-first.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e2697e2c-b043-4a0d-86cd-5764765cc13e/shopify-storefront-launch.png",
    artifactUrl:
      "https://web-design-pass3-shopify-storefront-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:shopify",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:shopify",
    ],
  },
  {
    slug: "kami-classroom-feedback",
    category: "website",
    title: "Kami Classroom Feedback",
    description:
      "A classroom feedback tool launch with annotated assignments, rubric panels, voice notes, and exports.",
    prompt:
      "Using `zero generate website` with design system `kami` and template `saas-landing`, create a landing page for a classroom feedback product. Annotated assignment mockup, rubric panel, voice notes, class insights, and export CTA. Make it feel friendly education, bright but organized, teacher-focused.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/47a1d32f-8219-4257-a5f6-7f83870a5521/kami-classroom-feedback.png",
    artifactUrl:
      "https://web-design-pass3-kami-classroom-feedback-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:kami",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:kami",
    ],
  },
  {
    slug: "lingo-brand-system",
    category: "website",
    title: "Lingo Brand System",
    description:
      "A brand system docs page with tokens, assets, usage rules, components, and approval workflows.",
    prompt:
      "Using `zero generate website` with design system `lingo` and template `docs-page`, create a docs page for a brand asset system. Token overview, asset library, usage rules, components, approvals, and examples. Make it feel brand governance, clean, precise.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7793f2ce-4aeb-4d75-be17-f401202fbf50/lingo-brand-system.png",
    artifactUrl:
      "https://web-design-pass3-lingo-brand-system-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:platform-design",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:lingo",
    resourceHints: [
      "od:skill:platform-design",
      "od:template:docs-page",
      "od:design-system:lingo",
    ],
  },
  {
    slug: "cisco-network-dashboard",
    category: "website",
    title: "Cisco Network Dashboard",
    description:
      "A network operations dashboard with topology, device health, incident queue, and policy status.",
    prompt:
      "Using `zero generate website` with design system `cisco` and template `dashboard`, create a network operations dashboard. Topology map, device health, incident queue, policy status, and bandwidth charts. Make it feel enterprise blue, dependable, ops-dense.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8b5419b7-c795-450f-80ca-ca9a01f94cdf/cisco-network-dashboard.png",
    artifactUrl:
      "https://web-design-pass3-cisco-network-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:cisco",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:cisco",
    ],
  },
  {
    slug: "ant-design-finance-console",
    category: "website",
    title: "Ant Design Finance Console",
    description:
      "A finance admin console with settlement status, reconciliation tables, approvals, and alerts.",
    prompt:
      "Using `zero generate website` with design system `ant` and template `dashboard`, create a finance operations admin console. Settlement KPIs, reconciliation table, approvals, alerts, and audit trail. Make it feel Ant-style, structured, enterprise.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/927e3715-08ed-4a7f-835e-0d019980ca4b/ant-design-finance-console.png",
    artifactUrl:
      "https://web-design-pass3-ant-design-finance-console-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:ant",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:ant",
    ],
  },
  {
    slug: "vodafone-5g-launch",
    category: "website",
    title: "Vodafone 5G Launch",
    description:
      "A 5G business connectivity launch with coverage map, plans, device bundles, and support.",
    prompt:
      "Using `zero generate website` with design system `vodafone` and template `saas-landing`, create a landing page for a 5G business connectivity offer. Coverage map, plan cards, device bundles, reliability proof, and contact sales CTA. Make it feel bold red, telecom clarity, commercial.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/953e4101-6842-4945-872c-e71eb9d58c67/vodafone-5g-launch.png",
    artifactUrl:
      "https://web-design-pass3-vodafone-5g-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:vodafone",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:vodafone",
    ],
  },
  {
    slug: "starbucks-rewards-launch",
    category: "website",
    title: "Starbucks Rewards Launch",
    description:
      "A rewards program launch with drink builder, points, member offers, and mobile ordering.",
    prompt:
      "Using `zero generate website` with design system `starbucks` and template `saas-landing`, create a landing page for a rewards program refresh. Drink builder, points explainer, member offers, mobile ordering, and join CTA. Make it feel warm green, cafe retail, approachable.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/89c435e1-7907-4f9f-8f85-657c199e4ad2/starbucks-rewards-launch.png",
    artifactUrl:
      "https://web-design-pass3-starbucks-rewards-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:starbucks",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:starbucks",
    ],
  },
  {
    slug: "webex-meeting-hub",
    category: "website",
    title: "Webex Meeting Hub",
    description:
      "A meeting hub dashboard with upcoming rooms, transcript tasks, recordings, and participant insights.",
    prompt:
      "Using `zero generate website` with design system `webex` and template `dashboard`, create a meeting collaboration dashboard. Upcoming rooms, transcript tasks, recordings, participant insights, and admin controls. Make it feel collaboration blue-green, calm, productive.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1d555ec0-d827-484e-a55b-e8522fbcbf6c/webex-meeting-hub.png",
    artifactUrl:
      "https://web-design-pass3-webex-meeting-hub-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:webex",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:webex",
    ],
  },
  {
    slug: "bmw-m-track-experience",
    category: "website",
    title: "BMW M Track Experience",
    description:
      "A premium performance driving experience page with schedule, telemetry, instructors, and booking.",
    prompt:
      "Using `zero generate website` with design system `bmw-m` and template `saas-landing`, create a launch page for a premium track driving experience. Hero, telemetry cards, instructor lineup, schedule, packages, and booking CTA. Make it feel motorsport blue-red, precise, premium.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/59514fb0-739c-4239-88c0-1d1d415471ad/bmw-m-track-experience.png",
    artifactUrl:
      "https://web-design-pass3-bmw-m-track-experience-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:bmw-m",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:bmw-m",
    ],
  },
  {
    slug: "agentic-ops-command",
    category: "website",
    title: "Agentic Ops Command",
    description:
      "An operations console for autonomous agents with run status, approvals, spend, and safeguards.",
    prompt:
      "Using `zero generate website` with design system `agentic` and template `dashboard`, create an operations dashboard for agent fleets. Agent status, approvals, spend, safeguards, incident log, and evaluation metrics. Make it feel AI operations, dark, controlled.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5c9c38c9-6e90-4870-a292-e192198663f2/agentic-ops-command.png",
    artifactUrl:
      "https://web-design-pass3-agentic-ops-command-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:agentic",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:agentic",
    ],
  },
  {
    slug: "application-admin-console",
    category: "website",
    title: "Application Admin Console",
    description:
      "A general application admin console with users, roles, audits, billing, and feature flags.",
    prompt:
      "Using `zero generate website` with design system `application` and template `dashboard`, create an application admin console. User table, role controls, audit log, billing status, and feature flags. Make it feel neutral app UI, efficient, familiar.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8043713f-c67d-4b59-981a-72ae4175a4b0/application-admin-console.png",
    artifactUrl:
      "https://web-design-pass3-application-admin-console-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:application",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:application",
    ],
  },
  {
    slug: "artistic-portfolio-showcase",
    category: "website",
    title: "Artistic Portfolio Showcase",
    description:
      "An artist portfolio feature with exhibition notes, process images, collector details, and press.",
    prompt:
      "Using `zero generate website` with design system `artistic` and template `blog-post`, create a portfolio feature page for a contemporary artist. Hero artwork, exhibition notes, process sections, collector details, and press quotes. Make it feel expressive, gallery-like, visual.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f10875c6-634a-4982-ad75-b59e5e1f0172/artistic-portfolio-showcase.png",
    artifactUrl:
      "https://web-design-pass3-artistic-portfolio-showcase-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:artistic",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:artistic",
    ],
  },
  {
    slug: "atelier-zero-brand-book",
    category: "website",
    title: "Atelier Zero Brand Book",
    description:
      "A studio brand book with typography, palette, layout rules, motion notes, and asset downloads.",
    prompt:
      "Using `zero generate website` with design system `atelier-zero` and template `docs-page`, create a brand book page for a design atelier. Typography, palette, layout rules, motion notes, components, and downloads. Make it feel editorial black-white, exacting, refined.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b3cb7bbc-c2f9-4c05-b215-6f9eda6da2a7/atelier-zero-brand-book.png",
    artifactUrl:
      "https://web-design-pass3-atelier-zero-brand-book-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:platform-design",
    templateId: "od:template:docs-page",
    designSystemId: "od:design-system:atelier-zero",
    resourceHints: [
      "od:skill:platform-design",
      "od:template:docs-page",
      "od:design-system:atelier-zero",
    ],
  },
  {
    slug: "bold-campaign-launch",
    category: "website",
    title: "Bold Campaign Launch",
    description:
      "A high-impact campaign page with punchy message hierarchy, proof blocks, offers, and signup.",
    prompt:
      "Using `zero generate website` with design system `bold` and template `saas-landing`, create a landing page for a high-impact marketing campaign. Huge hero, proof blocks, offer stack, testimonials, and signup CTA. Make it feel loud, confident, direct.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/056762c2-2168-4f2e-9c16-8120f3647589/bold-campaign-launch.png",
    artifactUrl:
      "https://web-design-pass3-bold-campaign-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:bold",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:bold",
    ],
  },
  {
    slug: "cafe-menu-story",
    category: "website",
    title: "Cafe Menu Story",
    description:
      "A cafe menu story page with seasonal drinks, roaster notes, food pairings, and location details.",
    prompt:
      "Using `zero generate website` with design system `cafe` and template `blog-post`, create a menu and story page for a neighborhood cafe. Seasonal drinks, roaster notes, food pairings, location details, and order CTA. Make it feel warm cafe, tactile, inviting.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bb9ad0a5-01d6-446e-974f-375e72d0aaa6/cafe-menu-story.png",
    artifactUrl:
      "https://web-design-pass3-cafe-menu-story-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:cafe",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:cafe",
    ],
  },
  {
    slug: "clay-product-tour",
    category: "website",
    title: "Clay Product Tour",
    description:
      "A product tour landing for a data enrichment workflow with tables, formulas, AI research, and CRM sync.",
    prompt:
      "Using `zero generate website` with design system `clay` and template `saas-landing`, create a landing page for a data enrichment product tour. Table mockup, formulas, AI research, CRM sync, templates, and demo CTA. Make it feel soft clay surfaces, modern GTM, crafted.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0d21a3f2-32a7-41de-957e-5509443d3e31/clay-product-tour.png",
    artifactUrl:
      "https://web-design-pass3-clay-product-tour-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:clay",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:clay",
    ],
  },
  {
    slug: "colorful-event-agenda",
    category: "website",
    title: "Colorful Event Agenda",
    description:
      "A conference agenda page with tracks, speakers, venue zones, sponsor moments, and live updates.",
    prompt:
      "Using `zero generate website` with design system `colorful` and template `saas-landing`, create a colorful event agenda website. Track filters, speaker cards, venue zones, sponsor moments, and live update strip. Make it feel bright multi-color, energetic, organized.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d9c220b0-b2d9-43a3-a329-d4922795c833/colorful-event-agenda.png",
    artifactUrl:
      "https://web-design-pass3-colorful-event-agenda-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:colorful",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:colorful",
    ],
  },
  {
    slug: "contemporary-architecture-feature",
    category: "website",
    title: "Contemporary Architecture Feature",
    description:
      "An architecture feature with project photography, plans, material notes, and critic commentary.",
    prompt:
      "Using `zero generate website` with design system `contemporary` and template `blog-post`, create an editorial architecture feature. Hero project, plans, material notes, spatial sections, and critic commentary. Make it feel modern editorial, restrained, image-forward.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/152df6d5-30df-4b18-9152-0e5d83c3d397/contemporary-architecture-feature.png",
    artifactUrl:
      "https://web-design-pass3-contemporary-architecture-feature-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:contemporary",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:contemporary",
    ],
  },
  {
    slug: "corporate-annual-report",
    category: "website",
    title: "Corporate Annual Report",
    description:
      "A corporate annual report page with CEO letter, metrics, business segments, ESG, and governance.",
    prompt:
      "Using `zero generate website` with design system `corporate` and template `blog-post`, create a corporate annual report website. CEO letter, financial metrics, segments, ESG cards, governance, and downloads. Make it feel formal, trustworthy, board-ready.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e168f5d6-68c0-4c28-b245-b89e6096a12c/corporate-annual-report.png",
    artifactUrl:
      "https://web-design-pass3-corporate-annual-report-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:corporate",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:corporate",
    ],
  },
  {
    slug: "creative-studio-home",
    category: "website",
    title: "Creative Studio Home",
    description:
      "A creative studio homepage with case studies, services, process, team, and inquiry CTA.",
    prompt:
      "Using `zero generate website` with design system `creative` and template `saas-landing`, create a homepage for a creative studio. Case-study hero, service grid, process timeline, team highlights, and inquiry CTA. Make it feel inventive, polished, portfolio-first.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/00a73dea-1ea5-436c-8412-ebd7191a8a79/creative-studio-home.png",
    artifactUrl:
      "https://web-design-pass3-creative-studio-home-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:creative",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:creative",
    ],
  },
  {
    slug: "dramatic-film-premiere",
    category: "website",
    title: "Dramatic Film Premiere",
    description:
      "A film premiere page with trailer surface, cast, showtimes, reviews, and ticket CTA.",
    prompt:
      "Using `zero generate website` with design system `dramatic` and template `saas-landing`, create a dramatic film premiere website. Trailer hero, cast cards, showtimes, critic quotes, gallery, and tickets. Make it feel cinematic, high contrast, theatrical.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/61dee99c-3846-464f-934b-27277fd2fa4e/dramatic-film-premiere.png",
    artifactUrl:
      "https://web-design-pass3-dramatic-film-premiere-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:dramatic",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:dramatic",
    ],
  },
  {
    slug: "elegant-jewelry-launch",
    category: "website",
    title: "Elegant Jewelry Launch",
    description:
      "A jewelry collection launch with product detail, materials, campaign photography, and appointments.",
    prompt:
      "Using `zero generate website` with design system `elegant` and template `saas-landing`, create a luxury jewelry collection launch page. Collection hero, material notes, product grid, campaign story, and appointment CTA. Make it feel elegant, quiet luxury, precise.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/05c0298f-f633-4136-b83b-56306af1e73d/elegant-jewelry-launch.png",
    artifactUrl:
      "https://web-design-pass3-elegant-jewelry-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:elegant",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:elegant",
    ],
  },
  {
    slug: "energetic-sports-app",
    category: "website",
    title: "Energetic Sports App",
    description:
      "A sports training app launch with workout streaks, coach plans, live challenges, and teams.",
    prompt:
      "Using `zero generate website` with design system `energetic` and template `saas-landing`, create a landing page for a sports training app. Workout streaks, coach plans, live challenges, team leaderboard, and start CTA. Make it feel athletic, high energy, mobile.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ca8f6f82-7e90-4d11-9ab9-0e71662887c1/energetic-sports-app.png",
    artifactUrl:
      "https://web-design-pass3-energetic-sports-app-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:energetic",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:energetic",
    ],
  },
  {
    slug: "enterprise-admin-portal",
    category: "website",
    title: "Enterprise Admin Portal",
    description:
      "An enterprise admin portal with org hierarchy, SSO, compliance tasks, device posture, and logs.",
    prompt:
      "Using `zero generate website` with design system `enterprise` and template `dashboard`, create an enterprise administration portal. Org hierarchy, SSO controls, compliance tasks, device posture, logs, and support cases. Make it feel serious enterprise, clear, secure.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4d4e295a-89b7-4cc7-b0cb-657e7678b048/enterprise-admin-portal.png",
    artifactUrl:
      "https://web-design-pass3-enterprise-admin-portal-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:enterprise",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:enterprise",
    ],
  },
  {
    slug: "expressive-music-festival",
    category: "website",
    title: "Expressive Music Festival",
    description:
      "A music festival page with lineup, stages, passes, artist stories, and schedule builder.",
    prompt:
      "Using `zero generate website` with design system `expressive` and template `saas-landing`, create a music festival website. Lineup, stages, passes, artist stories, schedule builder, and buy CTA. Make it feel expressive, rhythmic, colorful.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/dc04f0e4-3b48-4b6a-b28b-0a948cd1d700/expressive-music-festival.png",
    artifactUrl:
      "https://web-design-pass3-expressive-music-festival-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:expressive",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:expressive",
    ],
  },
  {
    slug: "fantasy-game-codex",
    category: "website",
    title: "Fantasy Game Codex",
    description:
      "A fantasy game companion with character classes, map lore, quest log, and preorder.",
    prompt:
      "Using `zero generate website` with design system `fantasy` and template `gamified-app`, create a game companion website for a fantasy RPG. Character classes, map lore, quest log, gear cards, and preorder CTA. Make it feel fantasy UI, immersive, ornate.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a1a79dd8-0a01-4ae6-882a-52e6e715f109/fantasy-game-codex.png",
    artifactUrl:
      "https://web-design-pass3-fantasy-game-codex-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:gamified-app",
    designSystemId: "od:design-system:fantasy",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:gamified-app",
      "od:design-system:fantasy",
    ],
  },
  {
    slug: "flat-saas-dashboard",
    category: "website",
    title: "Flat SaaS Dashboard",
    description:
      "A flat-style SaaS dashboard with pipeline, usage, support, conversion, and revenue widgets.",
    prompt:
      "Using `zero generate website` with design system `flat` and template `dashboard`, create a flat visual style SaaS dashboard. Pipeline, usage, support, conversion, revenue widgets, and filters. Make it feel flat color, clean, lightweight.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/648fb99c-7727-4741-81b6-a4f9475a46ad/flat-saas-dashboard.png",
    artifactUrl:
      "https://web-design-pass3-flat-saas-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:flat",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:flat",
    ],
  },
  {
    slug: "friendly-onboarding-flow",
    category: "website",
    title: "Friendly Onboarding Flow",
    description:
      "A product onboarding page with checklist, templates, team invites, empty states, and tips.",
    prompt:
      "Using `zero generate website` with design system `friendly` and template `saas-landing`, create a friendly product onboarding website. Checklist, template picker, team invites, empty states, and tips. Make it feel friendly, soft, clear.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/265a7736-2ede-4470-af64-4ecd4a2d9a7e/friendly-onboarding-flow.png",
    artifactUrl:
      "https://web-design-pass3-friendly-onboarding-flow-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:friendly",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:friendly",
    ],
  },
  {
    slug: "hud-flight-control",
    category: "website",
    title: "HUD Flight Control",
    description:
      "A flight control HUD dashboard with telemetry, route, weather, warnings, and handoff status.",
    prompt:
      "Using `zero generate website` with design system `hud` and template `dashboard`, create a futuristic flight control HUD. Telemetry, route, weather, warnings, handoff status, and mission controls. Make it feel glass HUD, high contrast, technical.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/73d21c43-148b-41e3-ae0d-5816b1de6628/hud-flight-control.png",
    artifactUrl:
      "https://web-design-pass3-hud-flight-control-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:hud",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:hud",
    ],
  },
  {
    slug: "levels-learning-path",
    category: "website",
    title: "Levels Learning Path",
    description:
      "A gamified learning path with modules, progress, badges, quizzes, and cohort leaderboard.",
    prompt:
      "Using `zero generate website` with design system `levels` and template `gamified-app`, create a gamified learning website. Module map, progress, badges, quiz cards, cohort leaderboard, and continue CTA. Make it feel leveled progression, playful, structured.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/24ae59fa-2ce9-4443-8094-56f3fd1c2128/levels-learning-path.png",
    artifactUrl:
      "https://web-design-pass3-levels-learning-path-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:gamified-app",
    designSystemId: "od:design-system:levels",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:gamified-app",
      "od:design-system:levels",
    ],
  },
  {
    slug: "luxury-hotel-launch",
    category: "website",
    title: "Luxury Hotel Launch",
    description:
      "A hotel launch page with suites, dining, spa, experiences, availability, and concierge CTA.",
    prompt:
      "Using `zero generate website` with design system `luxury` and template `saas-landing`, create a luxury hotel website. Suites, dining, spa, experiences, availability, and concierge CTA. Make it feel luxury hospitality, spacious, refined.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d061c92f-4208-4cd8-8aaa-0d38a1cc237c/luxury-hotel-launch.png",
    artifactUrl:
      "https://web-design-pass3-luxury-hotel-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:luxury",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:luxury",
    ],
  },
  {
    slug: "mission-control-space-ops",
    category: "website",
    title: "Mission Control Space Ops",
    description:
      "A mission control dashboard with orbital timeline, subsystem status, comms, and anomaly handling.",
    prompt:
      "Using `zero generate website` with design system `mission-control` and template `dashboard`, create a space mission control dashboard. Orbital timeline, subsystem status, communications, anomaly queue, and telemetry. Make it feel mission control, dark, precise.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d0b6ef8f-85bb-4aa8-a82b-e8e176d388c1/mission-control-space-ops.png",
    artifactUrl:
      "https://web-design-pass3-mission-control-space-ops-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:mission-control",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:mission-control",
    ],
  },
  {
    slug: "perspective-product-story",
    category: "website",
    title: "Perspective Product Story",
    description:
      "A product story page with layered feature perspectives, proof, customer paths, and conversion CTA.",
    prompt:
      "Using `zero generate website` with design system `perspective` and template `saas-landing`, create a perspective-driven product story page. Layered feature panels, proof blocks, customer paths, and CTA. Make it feel dimensional, narrative, polished.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a00072c0-1e45-4d44-acce-b7445b1be574/perspective-product-story.png",
    artifactUrl:
      "https://web-design-pass3-perspective-product-story-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:perspective",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:perspective",
    ],
  },
  {
    slug: "premium-membership-launch",
    category: "website",
    title: "Premium Membership Launch",
    description:
      "A membership pricing page with benefits, annual savings, comparison, social proof, and FAQ.",
    prompt:
      "Using `zero generate website` with design system `premium` and template `pricing-page`, create a premium membership pricing page. Benefit tiers, annual savings, comparison matrix, social proof, and FAQ. Make it feel premium, confident, conversion-focused.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f279b287-34b5-4708-b356-de068b9063c2/premium-membership-launch.png",
    artifactUrl:
      "https://web-design-pass3-premium-membership-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:paywall-upgrade-cro",
    templateId: "od:template:pricing-page",
    designSystemId: "od:design-system:premium",
    resourceHints: [
      "od:skill:paywall-upgrade-cro",
      "od:template:pricing-page",
      "od:design-system:premium",
    ],
  },
  {
    slug: "professional-services-home",
    category: "website",
    title: "Professional Services Home",
    description:
      "A professional services homepage with capabilities, industries, partner proof, insights, and contact.",
    prompt:
      "Using `zero generate website` with design system `professional` and template `saas-landing`, create a professional services website. Capabilities, industries, partner proof, insights, and contact CTA. Make it feel professional, restrained, credible.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bf0bf037-cb44-4551-8bc7-ac5d6ef3482b/professional-services-home.png",
    artifactUrl:
      "https://web-design-pass3-professional-services-home-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:professional",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:professional",
    ],
  },
  {
    slug: "publication-news-feature",
    category: "website",
    title: "Publication News Feature",
    description:
      "A news publication feature with headline package, timeline, data points, interviews, and related stories.",
    prompt:
      "Using `zero generate website` with design system `publication` and template `blog-post`, create a news publication feature article. Headline package, timeline, data cards, interviews, and related stories. Make it feel publication-grade, editorial, readable.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f3a436f7-bca8-4d9e-862b-9d6b9fc48cf0/publication-news-feature.png",
    artifactUrl:
      "https://web-design-pass3-publication-news-feature-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:publication",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:publication",
    ],
  },
  {
    slug: "refined-interior-design",
    category: "website",
    title: "Refined Interior Design",
    description:
      "An interior design project feature with room tours, materials, floor plan, sourcing, and designer notes.",
    prompt:
      "Using `zero generate website` with design system `refined` and template `blog-post`, create an interior design editorial page. Room tours, materials, floor plan, sourcing, and designer notes. Make it feel refined interiors, calm, textural.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fe46be5b-90f2-471e-afcf-5f7898cc45cc/refined-interior-design.png",
    artifactUrl:
      "https://web-design-pass3-refined-interior-design-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:refined",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:refined",
    ],
  },
  {
    slug: "sleek-device-launch",
    category: "website",
    title: "Sleek Device Launch",
    description:
      "A device launch page with product render, specs, ecosystem, preorder, and comparison.",
    prompt:
      "Using `zero generate website` with design system `sleek` and template `saas-landing`, create a sleek hardware device launch page. Product render, specs, ecosystem, comparison, preorder, and support. Make it feel sleek, minimal hardware, high polish.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fd470f7d-9655-452c-aa2e-a71f9f4d6d9c/sleek-device-launch.png",
    artifactUrl:
      "https://web-design-pass3-sleek-device-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:sleek",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:sleek",
    ],
  },
  {
    slug: "spacex-mission-brief",
    category: "website",
    title: "SpaceX Mission Brief",
    description:
      "A mission brief page with launch window, payload, trajectory, vehicle stats, and live webcast.",
    prompt:
      "Using `zero generate website` with design system `spacex` and template `saas-landing`, create a space launch mission brief website. Launch window, payload, trajectory, vehicle stats, webcast, and press kit. Make it feel aerospace black-white, technical, bold.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6d4f7f8e-6636-454f-8a54-8a110b908cc4/spacex-mission-brief.png",
    artifactUrl:
      "https://web-design-pass3-spacex-mission-brief-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:spacex",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:spacex",
    ],
  },
  {
    slug: "spacious-wellness-retreat",
    category: "website",
    title: "Spacious Wellness Retreat",
    description:
      "A wellness retreat page with schedule, rooms, treatments, landscape, and booking.",
    prompt:
      "Using `zero generate website` with design system `spacious` and template `saas-landing`, create a spacious wellness retreat website. Retreat schedule, rooms, treatments, landscape, pricing, and booking CTA. Make it feel spacious, serene, airy.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3fe24acf-0c3f-41df-8e07-af9e674fdd76/spacious-wellness-retreat.png",
    artifactUrl:
      "https://web-design-pass3-spacious-wellness-retreat-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:spacious",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:spacious",
    ],
  },
  {
    slug: "storytelling-nonprofit-campaign",
    category: "website",
    title: "Storytelling Nonprofit Campaign",
    description:
      "A nonprofit campaign story with beneficiary journeys, impact numbers, donation tiers, and updates.",
    prompt:
      "Using `zero generate website` with design system `storytelling` and template `blog-post`, create a story-led nonprofit campaign website. Beneficiary journeys, impact numbers, donation tiers, updates, and donate CTA. Make it feel story-led, empathetic, credible.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d2046995-1469-4d5a-8f18-8ca4c616d4de/storytelling-nonprofit-campaign.png",
    artifactUrl:
      "https://web-design-pass3-storytelling-nonprofit-campaign-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:storytelling",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:storytelling",
    ],
  },
  {
    slug: "totality-festival-guide",
    category: "website",
    title: "Totality Festival Guide",
    description:
      "A festival guide for an eclipse event with schedule, viewing zones, safety, lodging, and tickets.",
    prompt:
      "Using `zero generate website` with design system `totality-festival` and template `saas-landing`, create an eclipse festival guide website. Schedule, viewing zones, safety tips, lodging, lineup, and tickets. Make it feel cosmic festival, informative, memorable.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c68f8b6f-b735-422c-abc4-3ee2b7e8d86a/totality-festival-guide.png",
    artifactUrl:
      "https://web-design-pass3-totality-festival-guide-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:totality-festival",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:totality-festival",
    ],
  },
  {
    slug: "vibrant-food-market",
    category: "website",
    title: "Vibrant Food Market",
    description:
      "A food market page with vendors, tasting map, weekend events, membership, and ordering.",
    prompt:
      "Using `zero generate website` with design system `vibrant` and template `saas-landing`, create a vibrant food market website. Vendor grid, tasting map, weekend events, membership, ordering, and visit CTA. Make it feel vibrant, delicious, community.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/34953b82-c50e-42d4-9873-ec7242ddce2f/vibrant-food-market.png",
    artifactUrl:
      "https://web-design-pass3-vibrant-food-market-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:vibrant",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:vibrant",
    ],
  },
  {
    slug: "clean-operations-dashboard",
    category: "website",
    title: "Clean Operations Dashboard",
    description:
      "A clean operations dashboard with task queues, SLA health, team capacity, and weekly trends.",
    prompt:
      "Using `zero generate website` with design system `clean` and template `dashboard`, create a clean operations dashboard for service teams. Task queues, SLA health, team capacity, weekly trends, and handoff notes. Make it feel clean, restrained, practical.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/395f5976-2d38-4db2-93bd-2fd540ec82cc/clean-operations-dashboard.png",
    artifactUrl:
      "https://web-design-final-clean-operations-dashboard-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-design",
    templateId: "od:template:dashboard",
    designSystemId: "od:design-system:clean",
    resourceHints: [
      "od:skill:frontend-design",
      "od:template:dashboard",
      "od:design-system:clean",
    ],
  },
  {
    slug: "default-saas-home",
    category: "website",
    title: "Default SaaS Home",
    description:
      "A baseline SaaS homepage with product value, feature cards, customer proof, pricing, and signup.",
    prompt:
      "Using `zero generate website` with design system `default` and template `saas-landing`, create a default SaaS homepage that works as a neutral baseline. Hero value proposition, feature cards, customer proof, pricing teaser, and signup CTA. Make it feel neutral, dependable, broadly usable.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6509945c-edf9-4392-935f-1360ad6f6c9f/default-saas-home.png",
    artifactUrl:
      "https://web-design-final-default-saas-home-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:default",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:default",
    ],
  },
  {
    slug: "minimal-portfolio-index",
    category: "website",
    title: "Minimal Portfolio Index",
    description:
      "A minimal portfolio index with selected work, concise case notes, studio bio, and contact.",
    prompt:
      "Using `zero generate website` with design system `minimal` and template `blog-post`, create a minimal portfolio index for a design studio. Selected work, concise case notes, studio bio, process notes, and contact CTA. Make it feel minimal, quiet, precise.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/67f94b59-bda2-456a-980d-739d25aa73f3/minimal-portfolio-index.png",
    artifactUrl:
      "https://web-design-final-minimal-portfolio-index-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:minimal",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:minimal",
    ],
  },
  {
    slug: "modern-product-launch",
    category: "website",
    title: "Modern Product Launch",
    description:
      "A modern product launch page with a device mockup, feature narrative, integrations, testimonials, and trial CTA.",
    prompt:
      "Using `zero generate website` with design system `modern` and template `saas-landing`, create a modern product launch website. Device mockup, feature narrative, integrations, testimonials, and trial CTA. Make it feel modern, polished, conversion-focused.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9e856021-bb13-48a1-aab7-ac2ed35c000c/modern-product-launch.png",
    artifactUrl:
      "https://web-design-final-modern-product-launch-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:modern",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:modern",
    ],
  },
  {
    slug: "simple-notes-app",
    category: "website",
    title: "Simple Notes App",
    description:
      "A simple notes app landing page with capture, organization, sharing, sync, and export.",
    prompt:
      "Using `zero generate website` with design system `simple` and template `saas-landing`, create a simple notes app website. Capture flow, organization, sharing, sync, export, and download CTA. Make it feel simple, direct, friendly.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e9171292-32cb-44bb-afe5-87c1c4aadce2/simple-notes-app.png",
    artifactUrl:
      "https://web-design-final-simple-notes-app-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:frontend-skill",
    templateId: "od:template:saas-landing",
    designSystemId: "od:design-system:simple",
    resourceHints: [
      "od:skill:frontend-skill",
      "od:template:saas-landing",
      "od:design-system:simple",
    ],
  },
  {
    slug: "wired-tech-feature",
    category: "website",
    title: "WIRED Tech Feature",
    description:
      "A WIRED-style technology feature with a bold headline package, timeline, expert quotes, and related reading.",
    prompt:
      "Using `zero generate website` with design system `wired` and template `blog-post`, create a technology magazine feature article. Bold headline package, timeline, expert quotes, data callouts, and related reading. Make it feel WIRED-inspired, editorial, sharp.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/aec45e26-f8db-42b6-a39e-583662108eb5/wired-tech-feature.png",
    artifactUrl:
      "https://web-design-final-wired-tech-feature-715f6d07.sites.vm0.io",
    previewKind: "website",
    generationKind: "website",
    skillId: "od:skill:article-magazine",
    templateId: "od:template:blog-post",
    designSystemId: "od:design-system:wired",
    resourceHints: [
      "od:skill:article-magazine",
      "od:template:blog-post",
      "od:design-system:wired",
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
