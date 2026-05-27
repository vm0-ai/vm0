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
