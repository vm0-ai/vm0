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
    artifactUrl:
      "https://gallery-trial-data-docs-mono-715f6d07.sites.vm0.io",
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
    artifactUrl:
      "https://gallery-trial-brief-docs-mono-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5554d9d0-a6ed-48a8-b382-2fb8b90417d8/airtable-workflow-board.png",
    artifactUrl:
      "https://web-design-real-airtable-workflow-board-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f2075d3d-cf50-42e9-84d0-87007bb7fff6/arc-browser-launch.png",
    artifactUrl:
      "https://web-design-real-arc-browser-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c18c7ddb-d365-43ba-b377-a90e3be2ed83/bmw-i7-launch.png",
    artifactUrl:
      "https://web-design-real-bmw-i7-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2c752d6c-0f81-46e9-9a43-2aa554cfc9ce/bugatti-tourbillon-launch.png",
    artifactUrl:
      "https://web-design-real-bugatti-tourbillon-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/61130aab-271e-4005-aa4e-5d091bf36e3f/cal-scheduling-launch.png",
    artifactUrl:
      "https://web-design-real-cal-scheduling-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4cf5efb7-c951-4707-ad48-49ccb84277dd/cohere-enterprise-rag.png",
    artifactUrl:
      "https://web-design-real-cohere-enterprise-rag-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/70429456-6375-4914-962a-a698be572260/cosmic-space-sim.png",
    artifactUrl:
      "https://web-design-real-cosmic-space-sim-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/be27b4ec-c2ab-4a58-9b8e-297634c2f619/dithered-indie-launch.png",
    artifactUrl:
      "https://web-design-real-dithered-indie-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e32864f0-533f-4d5c-9e3e-37ded36fc4c1/doodle-kids-book.png",
    artifactUrl:
      "https://web-design-real-doodle-kids-book-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6534930d-857a-42c1-b157-cbca98685d96/duolingo-language-launch.png",
    artifactUrl:
      "https://web-design-real-duolingo-language-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/10245067-a79a-42fd-bac5-bc47bcc08af7/elevenlabs-voice-launch.png",
    artifactUrl:
      "https://web-design-real-elevenlabs-voice-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4c9ce0e9-839d-4ae9-9de2-4e81c4a369fe/ferrari-296-launch.png",
    artifactUrl:
      "https://web-design-real-ferrari-296-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/64441b0d-e193-4fc8-943e-12460b860cd3/gradient-fitness-launch.png",
    artifactUrl:
      "https://web-design-real-gradient-fitness-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3fb58b96-f5d6-4911-9506-94c122244fd8/hashicorp-config-docs.png",
    artifactUrl:
      "https://web-design-real-hashicorp-config-docs-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6324dcc4-900f-457e-9767-c7280033eccc/huggingface-transformers-docs.png",
    artifactUrl:
      "https://web-design-real-huggingface-transformers-docs-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6d2f6f86-e692-42a0-a824-46aee0bc70b8/ibm-quantum-feature.png",
    artifactUrl:
      "https://web-design-real-ibm-quantum-feature-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b05c2d58-6021-4f74-85cb-4d3194329bcb/kraken-spot-terminal.png",
    artifactUrl:
      "https://web-design-real-kraken-spot-terminal-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/683a5f7e-c4f1-4c67-a1b7-3a65ec398f47/lamborghini-revuelto-launch.png",
    artifactUrl:
      "https://web-design-real-lamborghini-revuelto-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3ddc8e30-8fbc-47f6-a43a-e74d6fe1a395/loom-async-video-launch.png",
    artifactUrl:
      "https://web-design-real-loom-async-video-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/64d39272-75c0-473e-b1e6-a2675c10574b/lovable-vibe-coding-launch.png",
    artifactUrl:
      "https://web-design-real-lovable-vibe-coding-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/de949e73-aa9b-4d0e-a2f2-06712d3d9740/mastercard-corporate-card.png",
    artifactUrl:
      "https://web-design-real-mastercard-corporate-card-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7f4828ff-dc2d-42ca-b212-bbb20fe00f2b/material-design-spec.png",
    artifactUrl:
      "https://web-design-real-material-design-spec-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b589dfb1-ddb0-4949-b597-be63f6664461/minimax-video-api-launch.png",
    artifactUrl:
      "https://web-design-real-minimax-video-api-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/59c660a6-2f25-47e8-b1f8-a3df08384404/miro-canvas-launch.png",
    artifactUrl:
      "https://web-design-real-miro-canvas-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5e673ba0-6108-469f-9ace-50e2a03e309d/mistral-open-weights-release.png",
    artifactUrl:
      "https://web-design-real-mistral-open-weights-release-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fbba3d81-31df-4867-87cb-4eb5a519dfd2/mongodb-query-docs.png",
    artifactUrl:
      "https://web-design-real-mongodb-query-docs-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/98f1fc2d-e40a-40cd-bf1a-ea6361e133fa/neon-cyberpunk-launch.png",
    artifactUrl:
      "https://web-design-real-neon-cyberpunk-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1e9908a6-6652-4a2d-9e84-f1a9776a000b/nvidia-accelerator-launch.png",
    artifactUrl:
      "https://web-design-real-nvidia-accelerator-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6d3231bb-d867-4e60-8cec-dce7148e2ba4/ollama-local-llm-docs.png",
    artifactUrl:
      "https://web-design-real-ollama-local-llm-docs-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2a10fc52-b038-4912-82fe-fa629b039750/opencode-agent-cli-docs.png",
    artifactUrl:
      "https://web-design-real-opencode-agent-cli-docs-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/16f1ab3b-0257-4f1c-b286-7211adda94bb/paper-zine-launch.png",
    artifactUrl:
      "https://web-design-real-paper-zine-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5f968040-e050-4268-b184-d83ae649e305/perplexity-research-assistant.png",
    artifactUrl:
      "https://web-design-real-perplexity-research-assistant-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c2d9b321-e60f-4a44-97d2-73636d97ebdb/renault-5-launch.png",
    artifactUrl:
      "https://web-design-real-renault-5-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/545d56c7-49cf-4e4f-8aa7-976db375c5c6/replicate-model-api-docs.png",
    artifactUrl:
      "https://web-design-real-replicate-model-api-docs-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f7fe62fb-171d-4edc-812f-b666434e1cd1/resend-email-api-pricing.png",
    artifactUrl:
      "https://web-design-real-resend-email-api-pricing-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d3459998-df66-4083-b505-599447e01d0e/runwayml-video-launch.png",
    artifactUrl:
      "https://web-design-real-runwayml-video-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9e51c68a-ad53-4231-9dc8-9073fe047c4f/sanity-cms-schema-docs.png",
    artifactUrl:
      "https://web-design-real-sanity-cms-schema-docs-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3d28463c-44a0-4129-b7ec-ea2745dc7c8c/sentry-error-dashboard.png",
    artifactUrl:
      "https://web-design-real-sentry-error-dashboard-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c88b7a86-c863-4e31-9699-223cf4a32f4e/shadcn-ui-component-docs.png",
    artifactUrl:
      "https://web-design-real-shadcn-ui-component-docs-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/867caed3-6cc1-49db-b872-2e8ba8692d61/skeumorphism-music-app.png",
    artifactUrl:
      "https://web-design-real-skeumorphism-music-app-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/01d17bda-319a-44d3-a2d5-3100ba9b4eb9/superhuman-email-launch.png",
    artifactUrl:
      "https://web-design-real-superhuman-email-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8e6c94d5-5972-400b-857a-b0bebee9d961/tetris-remix-launch.png",
    artifactUrl:
      "https://web-design-real-tetris-remix-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/26061976-ccd3-481c-a764-301d7bb23d20/together-ai-inference-pricing.png",
    artifactUrl:
      "https://web-design-real-together-ai-inference-pricing-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f510d41f-9bb3-4cd0-8130-c190834c8ae7/uber-rider-launch.png",
    artifactUrl:
      "https://web-design-real-uber-rider-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e1c731f0-149f-4ee3-b52b-877306c49a0f/urdu-poetry-feature.png",
    artifactUrl:
      "https://web-design-real-urdu-poetry-feature-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/842e1175-f1fb-4a3d-83e6-4ba1e2e17c88/vintage-style-magazine.png",
    artifactUrl:
      "https://web-design-real-vintage-style-magazine-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c979fca7-7e4f-4495-a7ce-041c46be7195/webflow-designer-launch.png",
    artifactUrl:
      "https://web-design-real-webflow-designer-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3ed8f7a4-d1c2-4172-8a4f-0ba2d62ee8a1/wise-transfer-launch.png",
    artifactUrl:
      "https://web-design-real-wise-transfer-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/606842ec-be7a-4b37-ba9a-7acd71dda8ce/x-ai-realtime-model-launch.png",
    artifactUrl:
      "https://web-design-real-x-ai-realtime-model-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6abd3129-0ddb-47e4-9dfa-18cc00a87fd8/zapier-automation-launch.png",
    artifactUrl:
      "https://web-design-real-zapier-automation-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c76134fc-9a0a-402d-9982-5674f416e06b/voltagent-agent-runtime.png",
    artifactUrl:
      "https://web-design-real-voltagent-agent-runtime-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/74444e4f-575b-4d0f-aa29-4a70fa2e27d1/composio-tool-catalog.png",
    artifactUrl:
      "https://web-design-real-composio-tool-catalog-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b11cb816-d2e7-48fe-b1ff-28dfbca99d86/warp-terminal-workflows.png",
    artifactUrl:
      "https://web-design-real-warp-terminal-workflows-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4a888772-ce20-4bd0-b158-b3ddd3a72498/expo-router-launch.png",
    artifactUrl:
      "https://web-design-real-expo-router-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6fae2679-75a5-49f5-a58d-9ede1ce26476/clickhouse-observability-dashboard.png",
    artifactUrl:
      "https://web-design-real-clickhouse-observability-dashboard-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d87e2335-8f44-4a5b-b4bb-a7fd2cba22b6/mintlify-docs-redesign.png",
    artifactUrl:
      "https://web-design-real-mintlify-docs-redesign-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5e00c315-e31f-44a6-873d-7ab384755dcc/pinterest-trend-board.png",
    artifactUrl:
      "https://web-design-real-pinterest-trend-board-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e77b4adc-fea8-4029-9b0e-33753e7b63a1/shopify-storefront-launch.png",
    artifactUrl:
      "https://web-design-real-shopify-storefront-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/101b16ab-d9d3-4992-b337-2885ef2399e5/kami-classroom-feedback.png",
    artifactUrl:
      "https://web-design-real-kami-classroom-feedback-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6e4b8fe9-45d9-4dda-8633-31707d4f3ad5/lingo-brand-system.png",
    artifactUrl:
      "https://web-design-real-lingo-brand-system-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f4d3c9f3-aa64-4707-a0bd-6e0d9f176d09/cisco-network-dashboard.png",
    artifactUrl:
      "https://web-design-real-cisco-network-dashboard-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c2a27caa-d8b6-4ba5-a8ec-6230cfeb1ff7/ant-design-finance-console.png",
    artifactUrl:
      "https://web-design-real-ant-design-finance-console-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b2625e3e-6089-4af1-ba62-5030a92b7ee4/vodafone-5g-launch.png",
    artifactUrl:
      "https://web-design-real-vodafone-5g-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c10251fb-3b51-4786-9953-2ca5d0d87c6a/starbucks-rewards-launch.png",
    artifactUrl:
      "https://web-design-real-starbucks-rewards-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/73c459f3-6b64-4bd4-ba13-f7bd32c767fe/webex-meeting-hub.png",
    artifactUrl:
      "https://web-design-real-webex-meeting-hub-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a0a0111d-da09-498d-a3dc-8736d9771e07/bmw-m-track-experience.png",
    artifactUrl:
      "https://web-design-real-bmw-m-track-experience-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/10d4ed3b-f9c7-4988-bf5b-a14f8d09b7e1/agentic-ops-command.png",
    artifactUrl:
      "https://web-design-real-agentic-ops-command-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/91e0fef2-77f3-4ba5-a4b8-47b0a3098117/application-admin-console.png",
    artifactUrl:
      "https://web-design-real-application-admin-console-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/17026d83-9318-4b78-ab54-52176f26a1d3/artistic-portfolio-showcase.png",
    artifactUrl:
      "https://web-design-real-artistic-portfolio-showcase-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6cacf4bf-a16f-481f-994d-d49dffd9a920/atelier-zero-brand-book.png",
    artifactUrl:
      "https://web-design-real-atelier-zero-brand-book-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e79b8406-6db1-4b71-8da2-6a5c760a5722/bold-campaign-launch.png",
    artifactUrl:
      "https://web-design-real-bold-campaign-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7ce0ea87-ecfd-43e0-8d47-d70dd4447da2/cafe-menu-story.png",
    artifactUrl:
      "https://web-design-real-cafe-menu-story-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/801c50ec-bcae-4f8a-b1f8-eb7faab4b39a/clay-product-tour.png",
    artifactUrl:
      "https://web-design-real-clay-product-tour-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ad19feef-7c09-464d-9339-481b87e19022/colorful-event-agenda.png",
    artifactUrl:
      "https://web-design-real-colorful-event-agenda-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5a00d488-eefb-4d7c-908a-98bd2be4211a/contemporary-architecture-feature.png",
    artifactUrl:
      "https://web-design-real-contemporary-architecture-feature-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7b8c676d-d2c8-420e-b13e-3fff71519249/corporate-annual-report.png",
    artifactUrl:
      "https://web-design-real-corporate-annual-report-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/290ef06c-6697-4c6b-8060-118a7fc71a74/creative-studio-home.png",
    artifactUrl:
      "https://web-design-real-creative-studio-home-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/58eb5b45-3a8d-4f76-9342-9c099f843c44/dramatic-film-premiere.png",
    artifactUrl:
      "https://web-design-real-dramatic-film-premiere-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9d6e82ee-6fb0-442d-8888-c6e51d421404/elegant-jewelry-launch.png",
    artifactUrl:
      "https://web-design-real-elegant-jewelry-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/40e395e2-7bbd-4feb-a213-f60ce74bb0ef/energetic-sports-app.png",
    artifactUrl:
      "https://web-design-real-energetic-sports-app-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/63ab098a-67b7-47bc-8b98-33f5f829039f/enterprise-admin-portal.png",
    artifactUrl:
      "https://web-design-real-enterprise-admin-portal-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/df799734-e4c8-498e-90f9-c789db4cfa11/expressive-music-festival.png",
    artifactUrl:
      "https://web-design-real-expressive-music-festival-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/65e0cb2f-b6d8-4ab6-8b19-463cc129c1e4/fantasy-game-codex.png",
    artifactUrl:
      "https://web-design-real-fantasy-game-codex-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c3c18bba-634f-454a-9774-e9975474937a/flat-saas-dashboard.png",
    artifactUrl:
      "https://web-design-real-flat-saas-dashboard-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/31adc693-1918-4375-bf1b-6702d0349447/friendly-onboarding-flow.png",
    artifactUrl:
      "https://web-design-real-friendly-onboarding-flow-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/862e4f6a-e3b0-4456-babc-e84a901545d6/hud-flight-control.png",
    artifactUrl:
      "https://web-design-real-hud-flight-control-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f675227d-cf90-47fc-9b16-b9adc2388898/levels-learning-path.png",
    artifactUrl:
      "https://web-design-real-levels-learning-path-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/24e90b0f-163c-4557-bb24-f866fc86df95/luxury-hotel-launch.png",
    artifactUrl:
      "https://web-design-real-luxury-hotel-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/22c402e0-85f0-4fe5-be26-2d2a42aa9780/mission-control-space-ops.png",
    artifactUrl:
      "https://web-design-real-mission-control-space-ops-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ecb453ed-d69a-4860-892d-be015afa9b7b/perspective-product-story.png",
    artifactUrl:
      "https://web-design-real-perspective-product-story-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/74d32a57-56a5-49e2-bb9f-ae401223b696/premium-membership-launch.png",
    artifactUrl:
      "https://web-design-real-premium-membership-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4e40e965-80bc-463b-8c82-280dac9a2777/professional-services-home.png",
    artifactUrl:
      "https://web-design-real-professional-services-home-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a2d34ac3-3ee9-4462-b5f9-91af04fbcc33/publication-news-feature.png",
    artifactUrl:
      "https://web-design-real-publication-news-feature-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6af889c8-8e2a-47a5-bde5-e320597ec3a1/refined-interior-design.png",
    artifactUrl:
      "https://web-design-real-refined-interior-design-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/16408fb6-f821-4dee-bfc4-5142659b75e8/sleek-device-launch.png",
    artifactUrl:
      "https://web-design-real-sleek-device-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f702f575-4549-414d-a275-30ae7a0621d4/spacex-mission-brief.png",
    artifactUrl:
      "https://web-design-real-spacex-mission-brief-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/16e77a04-db36-4ad3-8935-1ff70a4cbfb7/spacious-wellness-retreat.png",
    artifactUrl:
      "https://web-design-real-spacious-wellness-retreat-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/522333e5-f9a0-427e-a0da-4882786c9f5f/storytelling-nonprofit-campaign.png",
    artifactUrl:
      "https://web-design-real-storytelling-nonprofit-campaign-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9d30731e-3a4a-4e91-aedf-1bc3b0084b40/totality-festival-guide.png",
    artifactUrl:
      "https://web-design-real-totality-festival-guide-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5606c89c-80e5-4367-aeca-51d0a063519f/vibrant-food-market.png",
    artifactUrl:
      "https://web-design-real-vibrant-food-market-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/483b94cb-4c71-4e0e-b85b-297c50333ec6/clean-operations-dashboard.png",
    artifactUrl:
      "https://web-design-real-clean-operations-dashboard-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a33d2613-c9b0-448d-becb-5a0e1a153afa/default-saas-home.png",
    artifactUrl:
      "https://web-design-real-default-saas-home-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d1d469fd-7941-4f40-96e5-5b68253988c5/minimal-portfolio-index.png",
    artifactUrl:
      "https://web-design-real-minimal-portfolio-index-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2ca0e54a-702b-416a-8019-d3112ea27769/modern-product-launch.png",
    artifactUrl:
      "https://web-design-real-modern-product-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5d31f015-ba3e-476c-bef8-25f4198e55dc/simple-notes-app.png",
    artifactUrl:
      "https://web-design-real-simple-notes-app-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/93e955d4-90cb-4005-ba79-c67a851706a6/wired-tech-feature.png",
    artifactUrl:
      "https://web-design-real-wired-tech-feature-715f6d07.sites.vm0.io",
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
  }
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
