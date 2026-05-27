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
