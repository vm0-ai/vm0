export type OpenDesignTarget =
  | "image"
  | "presentation"
  | "website"
  | "dashboard-design"
  | "mobile-app-design"
  | "poster"
  | "intro-video"
  | "report"
  | "docs-design";

export type GenerationOutputKind =
  | "website"
  | "image"
  | "audio"
  | "video"
  | "presentation"
  | "report"
  | "poster"
  | "dashboard-design"
  | "mobile-app-design"
  | "docs-design"
  | "bundle";

type OpenDesignResourceKind =
  | "skill"
  | "template"
  | "design-system"
  | "image-style"
  | "audio-style"
  | "video-template"
  | "bundle-template";

interface OpenDesignSourceRef {
  readonly path: string;
  readonly repo?: string;
  readonly ref?: string;
}

export interface OpenDesignRegistryEntry {
  readonly id: string;
  readonly kind: OpenDesignResourceKind;
  readonly name: string;
  readonly description: string;
  readonly desc?: string;
  readonly source: OpenDesignSourceRef;
}

export interface OpenDesignCandidateSlice {
  readonly registryVersion: string;
  readonly source: {
    readonly repo: string;
    readonly ref: string;
  };
  readonly sources: readonly {
    readonly repo: string;
    readonly ref: string;
  }[];
  readonly candidates: {
    readonly skills: readonly OpenDesignRegistryEntry[];
    readonly templates: readonly OpenDesignRegistryEntry[];
    readonly designSystems: readonly OpenDesignRegistryEntry[];
    readonly imageStyles: readonly OpenDesignRegistryEntry[];
    readonly audioStyles: readonly OpenDesignRegistryEntry[];
    readonly videoTemplates: readonly OpenDesignRegistryEntry[];
    readonly bundleTemplates: readonly OpenDesignRegistryEntry[];
  };
}

const OPEN_DESIGN_REPO = "nexu-io/open-design";
const OPEN_DESIGN_COMMIT = "3fb620af423534643677c7c6fae76be088fa770a";
const VM0_SKILLS_REPO = "vm0-ai/vm0-skills";
const VM0_SKILLS_REF = "main";

const OPEN_DESIGN_REGISTRY_VERSION = `federated:${OPEN_DESIGN_REPO}@${OPEN_DESIGN_COMMIT}`;

const OPEN_DESIGN_REGISTRY: readonly OpenDesignRegistryEntry[] = [
  {
    id: "od:skill:article-magazine",
    kind: "skill",
    name: "Article Magazine",
    description:
      "Shapes research or editorial material into a magazine-like narrative with strong hierarchy.",
    source: { path: "skills/article-magazine/SKILL.md" },
  },
  {
    id: "od:skill:design-brief",
    kind: "skill",
    name: "Design Brief",
    description:
      "Converts a product, brand, or feature request into a structured design brief.",
    source: { path: "skills/design-brief/SKILL.md" },
  },
  {
    id: "od:skill:8-bit-orbit-video-template",
    kind: "skill",
    name: "8 Bit Orbit Video Template",
    description:
      "HyperFrames-based video template for retro pixel deck motion design — multi-scene HTML-to-video composition with advanced transitions and ready-to-render default style.",
    source: { path: "skills/8-bit-orbit-video-template/SKILL.md" },
  },
  {
    id: "od:skill:after-hours-editorial-template",
    kind: "skill",
    name: "After Hours Editorial Template",
    description:
      "Luxury dark-editorial HyperFrames template for three-page cinematic storyboards — haute couture title cards and magazine chapter spreads with moody serif-led storytelling.",
    source: { path: "skills/after-hours-editorial-template/SKILL.md" },
  },
  {
    id: "od:skill:algorithmic-art",
    kind: "skill",
    name: "Algorithmic Art",
    description:
      "Create generative art using p5.js with seeded randomness so every render is reproducible. Useful for procedural posters, motion-style stills, and artistic frame studies.",
    source: { path: "skills/algorithmic-art/SKILL.md" },
  },
  {
    id: "od:skill:apple-hig",
    kind: "skill",
    name: "Apple HIG",
    description:
      "Apple Human Interface Guidelines as 14 agent skills covering platforms, foundations, components, patterns, inputs, and technologies for iOS, macOS, visionOS, watchOS, and tvOS.",
    source: { path: "skills/apple-hig/SKILL.md" },
  },
  {
    id: "od:skill:brainstorming",
    kind: "skill",
    name: "Brainstorming",
    description:
      "Transform rough ideas into fully-formed designs through structured questioning and alternative exploration. Useful early in concept work.",
    source: { path: "skills/brainstorming/SKILL.md" },
  },
  {
    id: "od:skill:brand-guidelines",
    kind: "skill",
    name: "Brand Guidelines",
    description:
      "Apply Anthropic's official brand colors and typography to artifacts for consistent visual identity and professional design standards. A reference for shaping your own.",
    source: { path: "skills/brand-guidelines/SKILL.md" },
  },
  {
    id: "od:skill:canvas-design",
    kind: "skill",
    name: "Canvas Design",
    description:
      "Create beautiful visual art in PNG and PDF documents using design philosophy and aesthetic principles for posters, illustrations, and static pieces.",
    source: { path: "skills/canvas-design/SKILL.md" },
  },
  {
    id: "od:skill:card-twitter",
    kind: "skill",
    name: "Card Twitter",
    description: "Twitter quote or data card designed to pair with a post.",
    source: { path: "skills/card-twitter/SKILL.md" },
  },
  {
    id: "od:skill:card-xiaohongshu",
    kind: "skill",
    name: "Card Xiaohongshu",
    description:
      "Xiaohongshu-style knowledge cards, arranged as a swipeable multi-card carousel.",
    source: { path: "skills/card-xiaohongshu/SKILL.md" },
  },
  {
    id: "od:skill:color-expert",
    kind: "skill",
    name: "Color Expert",
    description:
      "Color science expert skill with 286K words of reference material covering OKLCH/OKLAB, palette generation, accessibility/contrast, color naming, pigment mixing, and historical color theory.",
    source: { path: "skills/color-expert/SKILL.md" },
  },
  {
    id: "od:skill:creative-director",
    kind: "skill",
    name: "Creative Director",
    description:
      "AI creative director with recursive self-assessment: 20+ methodologies (SIT, TRIZ, Bisociation, SCAMPER, Synectics), 3-axis evaluation calibrated against Cannes/D&AD/HumanKind, 5-phase process from brief to presentation.",
    source: { path: "skills/creative-director/SKILL.md" },
  },
  {
    id: "od:skill:d3-visualization",
    kind: "skill",
    name: "D3 Visualization",
    description:
      "Teaches the agent to produce D3 charts and interactive data visualizations. Useful for editorial dashboards, reports, and explanatory graphics.",
    source: { path: "skills/d3-visualization/SKILL.md" },
  },
  {
    id: "od:skill:deck-guizang-editorial",
    kind: "skill",
    name: "Deck Guizang Editorial",
    description:
      "Editorial magazine meets e-ink: 10 layouts and 5 palettes (Ink, Indigo Porcelain, Forest Ink, Kraft Paper, Dune).",
    source: { path: "skills/deck-guizang-editorial/SKILL.md" },
  },
  {
    id: "od:skill:deck-open-slide-canvas",
    kind: "skill",
    name: "Deck Open Slide Canvas",
    description:
      "Locked 1920x1080 canvas deck with React component-level free composition, not bound to a fixed template.",
    source: { path: "skills/deck-open-slide-canvas/SKILL.md" },
  },
  {
    id: "od:skill:deck-swiss-international",
    kind: "skill",
    name: "Deck Swiss International",
    description:
      "16-column grid, one saturated accent, and 22 locked layouts (Klein Blue, Lemon, Mint, Safety Orange).",
    source: { path: "skills/deck-swiss-international/SKILL.md" },
  },
  {
    id: "od:skill:design-consultation",
    kind: "skill",
    name: "Design Consultation",
    description:
      "Build a complete design system from scratch with creative risks and realistic product mockups. Useful for kickoff workshops and brand-from-zero work.",
    source: { path: "skills/design-consultation/SKILL.md" },
  },
  {
    id: "od:skill:design-md",
    kind: "skill",
    name: "Design MD",
    description:
      "Create and manage DESIGN.md files. Useful for capturing design direction, tokens, and visual rules in a single source of truth.",
    source: { path: "skills/design-md/SKILL.md" },
  },
  {
    id: "od:skill:design-review",
    kind: "skill",
    name: "Design Review",
    description:
      "Designer Who Codes: visual audit then fixes with atomic commits and before/after screenshots. Useful for tightening shipped UI before launch.",
    source: { path: "skills/design-review/SKILL.md" },
  },
  {
    id: "od:skill:digits-fintech-swiss-template",
    kind: "skill",
    name: "Digits Fintech Swiss Template",
    description:
      "Swiss-grid fintech deck template in black / warm paper / neon-lime — strict modular layout, bold numeric cards, restrained motion, keyboard/click navigation.",
    source: { path: "skills/digits-fintech-swiss-template/SKILL.md" },
  },
  {
    id: "od:skill:doc-kami-parchment",
    kind: "skill",
    name: "DOC Kami Parchment",
    description:
      "Warm parchment canvas (#f5f4ed), monochrome ink-blue accent (#1B365D), one serif family, and editorial-grade typography.",
    source: { path: "skills/doc-kami-parchment/SKILL.md" },
  },
  {
    id: "od:skill:editorial-burgundy-principles-template",
    kind: "skill",
    name: "Editorial Burgundy Principles Template",
    description:
      "Editorial studio deck template in burgundy / blush / muted-gold — pill tags, large typographic statements, principle cards, guided keyboard/click navigation.",
    source: { path: "skills/editorial-burgundy-principles-template/SKILL.md" },
  },
  {
    id: "od:skill:enhance-prompt",
    kind: "skill",
    name: "Enhance Prompt",
    description:
      "Improve prompts with design specs and UI/UX vocabulary. Useful for design-to-code workflows and clarifying requests for visual output.",
    source: { path: "skills/enhance-prompt/SKILL.md" },
  },
  {
    id: "od:skill:faq-page",
    kind: "skill",
    name: "FAQ Page",
    description:
      "A Frequently Asked Questions (FAQ) page with collapsible accordion sections, search functionality, and category filtering.",
    source: { path: "skills/faq-page/SKILL.md" },
  },
  {
    id: "od:skill:field-notes-editorial-template",
    kind: "skill",
    name: "Field Notes Editorial Template",
    description:
      "Editorial Field Notes report template — soft paper background, serif hero typography, rounded pastel insight cards, retention chart panel. Premium magazine-style.",
    source: { path: "skills/field-notes-editorial-template/SKILL.md" },
  },
  {
    id: "od:skill:figma-create-design-system-rules",
    kind: "skill",
    name: "Figma Create Design System Rules",
    description:
      "Generate project-specific design system rules for Figma-to-code workflows. Useful for capturing tokens, naming, and lint rules in one source.",
    source: { path: "skills/figma-create-design-system-rules/SKILL.md" },
  },
  {
    id: "od:skill:figma-generate-design",
    kind: "skill",
    name: "Figma Generate Design",
    description:
      "Build or update screens in Figma from code or description using design system components. Translate app pages into Figma using design tokens.",
    source: { path: "skills/figma-generate-design/SKILL.md" },
  },
  {
    id: "od:skill:figma-generate-library",
    kind: "skill",
    name: "Figma Generate Library",
    description:
      "Build or update a professional-grade design system library in Figma from a codebase. Useful for keeping the Figma source of truth in sync with shipped components.",
    source: { path: "skills/figma-generate-library/SKILL.md" },
  },
  {
    id: "od:skill:figma-implement-design",
    kind: "skill",
    name: "Figma Implement Design",
    description:
      "Translate Figma designs into production-ready code with 1:1 visual fidelity. Useful for handing off Figma frames straight to a frontend agent.",
    source: { path: "skills/figma-implement-design/SKILL.md" },
  },
  {
    id: "od:skill:flutter-animating-apps",
    kind: "skill",
    name: "Flutter Animating Apps",
    description:
      "Implement animated effects, transitions, and motion in Flutter apps. Useful for native iOS/Android motion design.",
    source: { path: "skills/flutter-animating-apps/SKILL.md" },
  },
  {
    id: "od:skill:frame-data-chart-nyt",
    kind: "skill",
    name: "Frame Data Chart Nyt",
    description:
      "NYT-newsroom typography, staggered reveal animation, and editorial-grade charts (line, bar, or range band).",
    source: { path: "skills/frame-data-chart-nyt/SKILL.md" },
  },
  {
    id: "od:skill:frame-flowchart-sticky",
    kind: "skill",
    name: "Frame Flowchart Sticky",
    description:
      "SVG curve connectors, sticky-note nodes, and cursor interaction with a whiteboard-brainstorm feel.",
    source: { path: "skills/frame-flowchart-sticky/SKILL.md" },
  },
  {
    id: "od:skill:frame-glitch-title",
    kind: "skill",
    name: "Frame Glitch Title",
    description:
      "Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes.",
    source: { path: "skills/frame-glitch-title/SKILL.md" },
  },
  {
    id: "od:skill:frame-light-leak-cinema",
    kind: "skill",
    name: "Frame Light Leak Cinema",
    description:
      "Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards.",
    source: { path: "skills/frame-light-leak-cinema/SKILL.md" },
  },
  {
    id: "od:skill:frame-liquid-bg-hero",
    kind: "skill",
    name: "Frame Liquid Bg Hero",
    description:
      "WebGL-style fluid displacement background with a quote overlay, suited to video intros, landing heroes, or posters.",
    source: { path: "skills/frame-liquid-bg-hero/SKILL.md" },
  },
  {
    id: "od:skill:frame-logo-outro",
    kind: "skill",
    name: "Frame Logo Outro",
    description:
      "Segmented logo assembly, glow bloom, and tagline reveal for video outros or brand closing frames.",
    source: { path: "skills/frame-logo-outro/SKILL.md" },
  },
  {
    id: "od:skill:frame-macos-notification",
    kind: "skill",
    name: "Frame Macos Notification",
    description:
      "Realistic macOS notification banner with app icon, title, and body, suited to video overlays or product teasers.",
    source: { path: "skills/frame-macos-notification/SKILL.md" },
  },
  {
    id: "od:skill:frontend-design",
    kind: "skill",
    name: "Frontend Design",
    description:
      "Frontend design and UI/UX development tools for shipping production-ready interfaces with strong typographic and layout discipline.",
    source: { path: "skills/frontend-design/SKILL.md" },
  },
  {
    id: "od:skill:frontend-dev",
    kind: "skill",
    name: "Frontend Dev",
    description:
      "Full-stack frontend with cinematic animations, AI-generated media via MiniMax API, and generative art. Useful for hero pages and showcase sites.",
    source: { path: "skills/frontend-dev/SKILL.md" },
  },
  {
    id: "od:skill:frontend-skill",
    kind: "skill",
    name: "Frontend Skill",
    description:
      "Create visually strong landing pages, websites, and app UIs with restrained composition. OpenAI's production frontend playbook.",
    source: { path: "skills/frontend-skill/SKILL.md" },
  },
  {
    id: "od:skill:frontend-slides",
    kind: "skill",
    name: "Frontend Slides",
    description:
      "Generate animation-rich HTML presentations with visual style previews. Useful for online keynotes, embedded talks, and interactive briefs.",
    source: { path: "skills/frontend-slides/SKILL.md" },
  },
  {
    id: "od:skill:gsap-core",
    kind: "skill",
    name: "GSAP Core",
    description:
      "Core GSAP API with gsap.to(), from(), fromTo(), easing, duration, stagger, and defaults. Production-grade web animation primitives.",
    source: { path: "skills/gsap-core/SKILL.md" },
  },
  {
    id: "od:skill:gsap-react",
    kind: "skill",
    name: "GSAP React",
    description:
      "GSAP React integration with useGSAP hook, refs, gsap.context(), cleanup, and SSR. Ships safe motion in React + Next.js apps.",
    source: { path: "skills/gsap-react/SKILL.md" },
  },
  {
    id: "od:skill:gsap-scrolltrigger",
    kind: "skill",
    name: "GSAP Scrolltrigger",
    description:
      "GSAP ScrollTrigger for scroll-linked animations, pinning, scrub, and refresh handling. Useful for editorial sites and product pages.",
    source: { path: "skills/gsap-scrolltrigger/SKILL.md" },
  },
  {
    id: "od:skill:gsap-timeline",
    kind: "skill",
    name: "GSAP Timeline",
    description:
      "GSAP Timelines with sequencing, position parameter, labels, nesting, and playback control. Useful for orchestrating multi-step motion sequences.",
    source: { path: "skills/gsap-timeline/SKILL.md" },
  },
  {
    id: "od:skill:hand-drawn-diagrams",
    kind: "skill",
    name: "Hand Drawn Diagrams",
    description:
      "Generate hand-drawn Excalidraw diagrams from a prompt - animated SVG, hosted edit link, and PNG export. Works with Claude Code, Codex, Gemini CLI, and any agent supporting standard skill paths.",
    source: { path: "skills/hand-drawn-diagrams/SKILL.md" },
  },
  {
    id: "od:skill:hatch-pet",
    kind: "skill",
    name: "Hatch Pet",
    description:
      "Create, repair, validate, preview, and package Codex-compatible animated pet spritesheets with an 8x9 atlas, QA contact sheets, preview videos, and pet.json packaging.",
    source: { path: "skills/hatch-pet/SKILL.md" },
  },
  {
    id: "od:skill:html-ppt-retro-quarterly-review",
    kind: "skill",
    name: "HTML PPT Retro Quarterly Review",
    description:
      "Retro Quarterly Review template — bold blue + orange editorial with slab headlines, cream paper sections, structured grids, fast premium motion pacing in video mode.",
    source: { path: "skills/html-ppt-retro-quarterly-review/SKILL.md" },
  },
  {
    id: "od:skill:login-flow",
    kind: "skill",
    name: "Login Flow",
    description: "Mobile login and authentication flow screens.",
    source: { path: "skills/login-flow/SKILL.md" },
  },
  {
    id: "od:skill:mockup-device-3d",
    kind: "skill",
    name: "Mockup Device 3D",
    description:
      "Static iPhone and MacBook 3D-style showcase with real HTML embedded on screens, glass-lens refraction, and 360-degree turntable composition.",
    source: { path: "skills/mockup-device-3d/SKILL.md" },
  },
  {
    id: "od:skill:paywall-upgrade-cro",
    kind: "skill",
    name: "Paywall Upgrade Cro",
    description:
      "Design and optimize upgrade screens, paywalls, and upsell modals. Useful for SaaS conversion design and pricing-page experiments.",
    source: { path: "skills/paywall-upgrade-cro/SKILL.md" },
  },
  {
    id: "od:skill:plan-design-review",
    kind: "skill",
    name: "Plan Design Review",
    description:
      "Senior Designer review: rates each design dimension 0-10, explains what a 10 looks like, and flags AI Slop signals. Useful as a gate before merging UI work.",
    source: { path: "skills/plan-design-review/SKILL.md" },
  },
  {
    id: "od:skill:platform-design",
    kind: "skill",
    name: "Platform Design",
    description:
      "300+ design rules from Apple HIG, Material Design 3, and WCAG 2.2 for cross-platform apps. Useful when shipping a single design across iOS, Android, and the web.",
    source: { path: "skills/platform-design/SKILL.md" },
  },
  {
    id: "od:skill:poster-hero",
    kind: "skill",
    name: "Poster Hero",
    description:
      "Vertical poster or Moments-style share image with strong visual impact.",
    source: { path: "skills/poster-hero/SKILL.md" },
  },
  {
    id: "od:skill:ppt-keynote",
    kind: "skill",
    name: "PPT Keynote",
    description:
      "Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation.",
    source: { path: "skills/ppt-keynote/SKILL.md" },
  },
  {
    id: "od:skill:release-notes-one-pager",
    kind: "skill",
    name: "Release Notes One Pager",
    description:
      'Release notes one-page HTML with highlights, Added, Fixed, Breaking changes, Known issues, and Upgrade note. Writes explicit "None" style sections whenever the user does not provide details.',
    source: { path: "skills/release-notes-one-pager/SKILL.md" },
  },
  {
    id: "od:skill:resume-modern",
    kind: "skill",
    name: "Resume Modern",
    description:
      "Modern minimal resume, single A4 page, ready for print or PDF export.",
    source: { path: "skills/resume-modern/SKILL.md" },
  },
  {
    id: "od:skill:screenshots-marketing",
    kind: "skill",
    name: "Screenshots Marketing",
    description:
      "Generate marketing screenshots with Playwright. Useful for landing-page hero shots, App Store screenshots, and changelog visuals.",
    source: { path: "skills/screenshots-marketing/SKILL.md" },
  },
  {
    id: "od:skill:shadcn-ui",
    kind: "skill",
    name: "Shadcn UI",
    description:
      "Build UI components with shadcn/ui. Pairs with the Stitch design loop to ship structured, accessible components quickly.",
    source: { path: "skills/shadcn-ui/SKILL.md" },
  },
  {
    id: "od:skill:shader-dev",
    kind: "skill",
    name: "Shader Dev",
    description:
      "GLSL shader techniques for ray marching, fluid simulation, particle systems, and procedural generation. Useful for hero visuals and motion stills.",
    source: { path: "skills/shader-dev/SKILL.md" },
  },
  {
    id: "od:skill:slack-gif-creator",
    kind: "skill",
    name: "Slack GIF Creator",
    description:
      "Create animated GIFs optimized for Slack with validators for size constraints and composable animation primitives.",
    source: { path: "skills/slack-gif-creator/SKILL.md" },
  },
  {
    id: "od:skill:slides",
    kind: "skill",
    name: "Slides",
    description:
      "Create and edit .pptx presentation decks with PptxGenJS. Useful for sales decks, kickoff briefs, and design-system showcases.",
    source: { path: "skills/slides/SKILL.md" },
  },
  {
    id: "od:skill:social-reddit-card",
    kind: "skill",
    name: "Social Reddit Card",
    description:
      "Realistic Reddit post card with vote rail and comment count, suited to video overlays or story sharing.",
    source: { path: "skills/social-reddit-card/SKILL.md" },
  },
  {
    id: "od:skill:social-spotify-card",
    kind: "skill",
    name: "Social Spotify Card",
    description:
      "Spotify Now Playing-style card with album art, progress bar, and playback controls, suited to video overlays or personal homepages.",
    source: { path: "skills/social-spotify-card/SKILL.md" },
  },
  {
    id: "od:skill:social-x-post-card",
    kind: "skill",
    name: "Social X Post Card",
    description:
      "Realistic X post card with engagement metrics (likes, reposts, views), suited to video overlays or shareable image cards.",
    source: { path: "skills/social-x-post-card/SKILL.md" },
  },
  {
    id: "od:skill:stitch-loop",
    kind: "skill",
    name: "Stitch Loop",
    description:
      "Iterative design-to-code feedback loop. Critique adjust ship cycle for tightening visual fidelity between brief and built UI.",
    source: { path: "skills/stitch-loop/SKILL.md" },
  },
  {
    id: "od:skill:swiftui-design",
    kind: "skill",
    name: "Swiftui Design",
    description:
      "SwiftUI skill - anti AI-slop rules, design direction advisor, brand asset protocol, and five-dimension review. Works with Claude Code, Cursor, Codex, and OpenCode.",
    source: { path: "skills/swiftui-design/SKILL.md" },
  },
  {
    id: "od:skill:swiss-creative-mode-template",
    kind: "skill",
    name: "Swiss Creative Mode Template",
    description:
      "Swiss-inspired creative-mode presentation template — bold editorial typography, high-contrast geometric cards, interactive slide navigation, theme switching, hotspot overlays.",
    source: { path: "skills/swiss-creative-mode-template/SKILL.md" },
  },
  {
    id: "od:skill:swiss-user-research-video-template",
    kind: "skill",
    name: "Swiss User Research Video Template",
    description:
      "Swiss-style user-research narrative template in warm-paper editorial aesthetics — minimalist typography, donut breakdowns, keyboard/click navigation, single-file HTML.",
    source: { path: "skills/swiss-user-research-video-template/SKILL.md" },
  },
  {
    id: "od:skill:taste-skill",
    kind: "skill",
    name: "Taste Skill",
    description:
      "High-agency frontend skill that gives AI good taste with tunable design variance, motion intensity, and visual density to stop generic UI slop.",
    source: { path: "skills/taste-skill/SKILL.md" },
  },
  {
    id: "od:skill:theme-factory",
    kind: "skill",
    name: "Theme Factory",
    description:
      "Apply professional font and color themes to artifacts including slides, docs, reports, and HTML landing pages. Ships 10 pre-set themes.",
    source: { path: "skills/theme-factory/SKILL.md" },
  },
  {
    id: "od:skill:threejs",
    kind: "skill",
    name: "Threejs",
    description:
      "Three.js skills for creating 3D elements and interactive experiences in the browser - scenes, materials, controls, and post-processing.",
    source: { path: "skills/threejs/SKILL.md" },
  },
  {
    id: "od:skill:ui-skills",
    kind: "skill",
    name: "UI Skills",
    description:
      "Opinionated, evolving constraints to guide agents when building interfaces. Useful for keeping output coherent across many small UI pieces.",
    source: { path: "skills/ui-skills/SKILL.md" },
  },
  {
    id: "od:skill:ui-ux-pro-max",
    kind: "skill",
    name: "UI UX Pro Max",
    description:
      "Catalog-only UI/UX Pro Max entry. The full upstream templates, data, and search workflow are not bundled in this registry.",
    source: { path: "skills/ui-ux-pro-max/SKILL.md" },
  },
  {
    id: "od:skill:vfx-text-cursor",
    kind: "skill",
    name: "VFX Text Cursor",
    description:
      "Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros.",
    source: { path: "skills/vfx-text-cursor/SKILL.md" },
  },
  {
    id: "od:skill:video-hyperframes",
    kind: "skill",
    name: "Video Hyperframes",
    description:
      "Hyperframes / Remotion-compatible continuous frame animation with autoplay support.",
    source: { path: "skills/video-hyperframes/SKILL.md" },
  },
  {
    id: "od:skill:web-design-guidelines",
    kind: "skill",
    name: "Web Design Guidelines",
    description:
      "Web design guidelines and standards by the Vercel engineering team. Covers layout, typography, color, motion, and accessibility for product UI.",
    source: { path: "skills/web-design-guidelines/SKILL.md" },
  },
  {
    id: "od:skill:weread-year-in-review-video-template",
    kind: "skill",
    name: "Weread Year In Review Video Template",
    description:
      "WeRead-inspired HyperFrames video template for vertical annual reading reports — warm paper texture, editorial Chinese typography, book-page metaphors, deterministic motion.",
    source: { path: "skills/weread-year-in-review-video-template/SKILL.md" },
  },
  {
    id: "od:skill:wpds",
    kind: "skill",
    name: "WPDS",
    description:
      "WordPress Design System. Apply WordPress's official design tokens, typography, and component patterns to themes and sites.",
    source: { path: "skills/wpds/SKILL.md" },
  },
  {
    id: "od:template:dashboard",
    kind: "template",
    name: "Dashboard",
    description:
      "Admin or analytics dashboard in a single HTML file with fixed sidebar, top bar, KPI cards, and one or two charts.",
    source: { path: "design-templates/dashboard" },
  },
  {
    id: "od:template:finance-report",
    kind: "template",
    name: "Finance Report",
    description:
      "Quarterly or monthly financial report with masthead KPIs, revenue and burn charts, P&L summary, highlights, and outlook.",
    source: { path: "design-templates/finance-report" },
  },
  {
    id: "od:template:docs-page",
    kind: "template",
    name: "Docs Page",
    description:
      "Documentation page with inline-start navigation, scrollable article body, and inline-end table of contents.",
    source: { path: "design-templates/docs-page" },
  },
  {
    id: "od:template:mobile-app",
    kind: "template",
    name: "Mobile App Design",
    description:
      "Mobile app screen rendered inside a pixel-accurate iPhone 15 Pro frame using reusable screen archetypes.",
    source: { path: "design-templates/mobile-app" },
  },
  {
    id: "od:template:html-ppt-graphify-dark-graph",
    kind: "template",
    name: "Graphify Dark Graph",
    description:
      "Dark knowledge-graph deck with midnight gradients, force-graph cover visuals, command-line highlights, and glass-morphism cards.",
    source: { path: "design-templates/html-ppt-graphify-dark-graph" },
  },
  {
    id: "od:template:html-ppt-zhangzara-retro-zine",
    kind: "template",
    name: "Zhangzara Retro Zine",
    description:
      "Retro editorial zine presentation template with expressive composition, tactile paper energy, and bold magazine-like rhythm.",
    source: { path: "design-templates/html-ppt-zhangzara-retro-zine" },
  },
  {
    id: "od:template:weekly-update",
    kind: "template",
    name: "Weekly Update",
    description:
      "Single-file horizontal-swipe weekly team update deck for shipped work, in-flight work, blockers, metrics, and asks.",
    source: { path: "design-templates/weekly-update" },
  },
  {
    id: "od:template:web-prototype-taste-editorial",
    kind: "template",
    name: "Taste Editorial Web Prototype",
    description:
      "Editorial-minimalist web prototype with warm monochrome canvas, serif display type, hairline borders, pastel chips, and ambient micro-motion.",
    source: { path: "design-templates/web-prototype-taste-editorial" },
  },
  {
    id: "od:template:audio-jingle",
    kind: "template",
    name: "Audio Jingle",
    description:
      "Audio generation skill — jingles, beds, voiceover, and sound effects. Routes music requests to Suno V5 / Udio / Lyria, speech to MiniMax TTS / FishAudio / ElevenLabs V3, and SFX to ElevenLabs SFX or AudioCraft. Output is one MP3/WAV file…",
    source: { path: "design-templates/audio-jingle" },
  },
  {
    id: "od:template:blog-post",
    kind: "template",
    name: "Blog Post",
    description:
      "A long-form article / blog post — masthead, hero image placeholder, article body with figures and pull quotes, author byline, related posts.",
    source: { path: "design-templates/blog-post" },
  },
  {
    id: "od:template:clinical-case-report",
    kind: "template",
    name: "Clinical Case Report",
    description:
      "Structured medical case presentation for clinical rounds, conferences, and documentation. Generates SOAP-format or narrative case reports with physiologically accurate vitals, labs, and evidence-based plans.",
    source: { path: "design-templates/clinical-case-report" },
  },
  {
    id: "od:template:critique",
    kind: "template",
    name: "Critique",
    description:
      "Run a 5-dimension expert design review on any HTML artifact in the project — Philosophy / Visual hierarchy / Detail / Functionality / Innovation, each scored 0–10. Outputs a single self-contained HTML report with a radar chart, evidence…",
    source: { path: "design-templates/critique" },
  },
  {
    id: "od:template:dating-web",
    kind: "template",
    name: "Dating Web",
    description:
      "A consumer-feeling dating / matchmaking dashboard — left rail navigation, ticker bar of community signals, headline KPIs, a 30-day mutual-matches bar chart, and a match-rate trend block. Editorial typography, restrained accent.",
    source: { path: "design-templates/dating-web" },
  },
  {
    id: "od:template:dcf-valuation",
    kind: "template",
    name: "Dcf Valuation",
    description:
      "Discounted cash flow valuation and intrinsic value analysis for public companies.",
    source: { path: "design-templates/dcf-valuation" },
  },
  {
    id: "od:template:digital-eguide",
    kind: "template",
    name: "Digital Eguide",
    description:
      'A two-spread digital e-guide preview — page 1 is a cover (display title, author, "What\'s inside" stats, table of contents teaser); page 2 is a spread (lesson body with pull-quote and a step list). Lifestyle / creator brand tone.',
    source: { path: "design-templates/digital-eguide" },
  },
  {
    id: "od:template:email-marketing",
    kind: "template",
    name: "Email Marketing",
    description:
      "A brand product-launch email — masthead with wordmark, hero image block, headline lockup with skewed-italic accent, body copy, primary CTA, and a specifications grid. Pure HTML email layout (centered single column, table fallback).",
    source: { path: "design-templates/email-marketing" },
  },
  {
    id: "od:template:eng-runbook",
    kind: "template",
    name: "Eng Runbook",
    description:
      "An engineering runbook — service overview, alerts table, dashboards links, common procedures with copy-pasteable commands, on-call rotation, and an incident-response checklist.",
    source: { path: "design-templates/eng-runbook" },
  },
  {
    id: "od:template:flowai-live-dashboard-template",
    kind: "template",
    name: "Flowai Live Dashboard Template",
    description:
      "FlowAI team-management dashboard — three tabs (Members, Details, Activity Log), KPI row, role chart, presence sparklines, contributor panel, light/dark, CSV export, single HTML.",
    source: { path: "design-templates/flowai-live-dashboard-template" },
  },
  {
    id: "od:template:gamified-app",
    kind: "template",
    name: "Gamified App",
    description:
      "A multi-frame gamified mobile-app prototype — three phone frames on a dark showcase stage. Frame 1: cover / poster, Frame 2: today's quests with XP ribbons and a level bar, Frame 3: quest detail. Vivid quest tiles, level ribbon, bottom t…",
    source: { path: "design-templates/gamified-app" },
  },
  {
    id: "od:template:github-dashboard",
    kind: "template",
    name: "Github Dashboard",
    description:
      "GitHub repository analytics dashboard — stars, forks, contributors, issues, pull requests, recent activity, and top contributors.",
    source: { path: "design-templates/github-dashboard" },
  },
  {
    id: "od:template:guizang-ppt",
    kind: "template",
    name: "Guizang PPT",
    description:
      "电子杂志 × 电子墨水风格的横向翻页网页 PPT — WebGL 流体背景、衬线标题、章节幕封、数据大字报、图片网格。适合分享 / 演讲 / 发布会 / 杂志风 PPT。",
    source: { path: "design-templates/guizang-ppt" },
  },
  {
    id: "od:template:hr-onboarding",
    kind: "template",
    name: "Hr Onboarding",
    description:
      'A new-hire onboarding plan as a single page — first week schedule, buddy + manager intro, learning track, equipment checklist, and "you\'re set when…" outcomes.',
    source: { path: "design-templates/hr-onboarding" },
  },
  {
    id: "od:template:html-ppt",
    kind: "template",
    name: "HTML PPT",
    description:
      "HTML PPT Studio — static HTML presentations driven by templates. Many styles, layouts, animations, and keyboard navigation for talks, pitches, reports, and 小红书图文.",
    source: { path: "design-templates/html-ppt" },
  },
  {
    id: "od:template:html-ppt-course-module",
    kind: "template",
    name: "HTML PPT Course Module",
    description:
      "Online-course / workshop module deck — warm paper background + Playfair serif, persistent left sidebar of learning objectives, MCQ self-check page. Use for teaching modules, training materials, workshop slides.",
    source: { path: "design-templates/html-ppt-course-module" },
  },
  {
    id: "od:template:html-ppt-dir-key-nav-minimal",
    kind: "template",
    name: "HTML PPT Dir Key Nav Minimal",
    description:
      "极简方向键 keynote — 每页独立单色背景、160px display 标题、4px accent 线、箭头 → 前缀 Mono 列表、← → kbd 提示。适合 keynote、launch、公开演讲。",
    source: { path: "design-templates/html-ppt-dir-key-nav-minimal" },
  },
  {
    id: "od:template:html-ppt-hermes-cyber-terminal",
    kind: "template",
    name: "HTML PPT Hermes Cyber Terminal",
    description:
      "暗终端 honest-review deck — 黑底 + 赛博网格 + CRT 暗角 + 扫描线、`$ prompt` 命令行标题、薄荷绿大字、JetBrains Mono、stroke-only 柱状图。适合 CLI/agent/dev tool 测评。",
    source: { path: "design-templates/html-ppt-hermes-cyber-terminal" },
  },
  {
    id: "od:template:html-ppt-knowledge-arch-blueprint",
    kind: "template",
    name: "HTML PPT Knowledge Arch Blueprint",
    description:
      "奶油蓝图架构 deck — 奶油纸底色 + 单一锈红高亮、48px 蓝图网格、2px 黑边硬卡片、pipeline 步骤盒、右侧 insight callout、Playfair 衬线大字。零渐变零软阴影。",
    source: { path: "design-templates/html-ppt-knowledge-arch-blueprint" },
  },
  {
    id: "od:template:html-ppt-obsidian-claude-gradient",
    kind: "template",
    name: "HTML PPT Obsidian Claude Gradient",
    description:
      "GitHub 暗紫渐变 deck — GitHub-dark + 紫蓝 radial 环境光 + 60px 网格、紫色 pill 标签、三色渐变标题、GitHub 风代码 palette。适合开发者工作流 / MCP / Agent 教程。",
    source: { path: "design-templates/html-ppt-obsidian-claude-gradient" },
  },
  {
    id: "od:template:html-ppt-pitch-deck",
    kind: "template",
    name: "HTML PPT Pitch Deck",
    description:
      "Investor-ready 10-slide HTML pitch deck — white + blue→purple gradient hero, big numbers, traction bar chart, $4.5M-style ask page.",
    source: { path: "design-templates/html-ppt-pitch-deck" },
  },
  {
    id: "od:template:html-ppt-presenter-mode-reveal",
    kind: "template",
    name: "HTML PPT Presenter Mode Reveal",
    description:
      "演讲者模式 deck — tokyo-night 默认主题，5 套主题 T 键切换，每页带 150-300 字逐字稿示例，按 S 打开 CURRENT/NEXT/SCRIPT/TIMER 四张磁吸卡片。适合提词器场景。",
    source: { path: "design-templates/html-ppt-presenter-mode-reveal" },
  },
  {
    id: "od:template:html-ppt-product-launch",
    kind: "template",
    name: "HTML PPT Product Launch",
    description:
      "Launch keynote deck — dark hero + light content, warm orange→peach accent, feature cards, pricing tiers, CTA.",
    source: { path: "design-templates/html-ppt-product-launch" },
  },
  {
    id: "od:template:html-ppt-taste-brutalist",
    kind: "template",
    name: "HTML PPT Taste Brutalist",
    description:
      "16:9 HTML deck in tactical-telemetry / CRT-terminal taste. Deactivated-CRT charcoal slides, white-phosphor monospace, hazard-red accent, scanline overlay, ASCII syntax, density over decoration. Distilled from Leonxlnx/taste-skill `brutal…",
    source: { path: "design-templates/html-ppt-taste-brutalist" },
  },
  {
    id: "od:template:html-ppt-taste-editorial",
    kind: "template",
    name: "HTML PPT Taste Editorial",
    description:
      "16:9 HTML deck in editorial-minimalist taste. Warm cream slides, serif display + grotesque body, hairline rules, monospace meta, generous macro-whitespace, one accent. Distilled from Leonxlnx/taste-skill `minimalist-skill`.",
    source: { path: "design-templates/html-ppt-taste-editorial" },
  },
  {
    id: "od:template:html-ppt-tech-sharing",
    kind: "template",
    name: "HTML PPT Tech Sharing",
    description:
      "Conference / internal tech-talk deck — GitHub-dark, JetBrains Mono, terminal code blocks, agenda + Q&A pages. Use for engineering presentations, internal sharing sessions, conference talks, and code-heavy walkthroughs.",
    source: { path: "design-templates/html-ppt-tech-sharing" },
  },
  {
    id: "od:template:html-ppt-testing-safety-alert",
    kind: "template",
    name: "HTML PPT Testing Safety Alert",
    description:
      "红琥珀警示 deck — 顶/底 45° 红黑 hazard 条纹、红色否定标题、L1/L2/L3 三档卡片、policy-yaml 代码块、红绿 checklist、事故堆叠柱状图。适合安全 / 风险 / 复盘 / 红队。",
    source: { path: "design-templates/html-ppt-testing-safety-alert" },
  },
  {
    id: "od:template:html-ppt-weekly-report",
    kind: "template",
    name: "HTML PPT Weekly Report",
    description:
      "Team weekly / status-update deck — corporate clarity, 8-cell KPI grid, shipped list, 8-week bar chart, next-week table. Use for 周报, business reviews, team status updates, and exec dashboards.",
    source: { path: "design-templates/html-ppt-weekly-report" },
  },
  {
    id: "od:template:html-ppt-xhs-pastel-card",
    kind: "template",
    name: "HTML PPT Xhs Pastel Card",
    description:
      "柔和马卡龙慢生活 deck — 奶油底 + 柔光 blob、Playfair 斜体 + sans 正文、28px 圆角马卡龙卡片、SVG donut 图、chip+page 顶栏。适合生活方式 / 个人成长 / 慢生活内容。",
    source: { path: "design-templates/html-ppt-xhs-pastel-card" },
  },
  {
    id: "od:template:html-ppt-xhs-post",
    kind: "template",
    name: "HTML PPT Xhs Post",
    description:
      "小红书 / Instagram 风 9 页 3:4 竖版图文（810×1080）— 暖色 pastel、虚线 sticker 卡片、底部页码点点。",
    source: { path: "design-templates/html-ppt-xhs-post" },
  },
  {
    id: "od:template:html-ppt-xhs-white-editorial",
    kind: "template",
    name: "HTML PPT Xhs White Editorial",
    description:
      "白底杂志风 deck — 纯白 + 顶部 10 色彩虹 bar、80-110px display 标题、紫→蓝→绿→橙→粉渐变文字、马卡龙软卡片组、黑底白字 .focus pill。小红书图文 + 横版 PPT 双用。",
    source: { path: "design-templates/html-ppt-xhs-white-editorial" },
  },
  {
    id: "od:template:html-ppt-zhangzara-8-bit-orbit",
    kind: "template",
    name: "HTML PPT Zhangzara 8 Bit Orbit",
    description:
      "8-Bit Orbit — pixel-art neon arcade aesthetic on a deep navy void. For cyberpunk, gaming, web3, indie dev tools, hackathon demos that should feel like a CRT screen at 2am.",
    source: { path: "design-templates/html-ppt-zhangzara-8-bit-orbit" },
  },
  {
    id: "od:template:html-ppt-zhangzara-biennale-yellow",
    kind: "template",
    name: "HTML PPT Zhangzara Biennale Yellow",
    description:
      "Biennale Yellow — solar yellow on warm parchment with deep indigo serif and sun-glow gradients. For art-biennale posters, museum programmes, curatorial pitches, literary publications.",
    source: { path: "design-templates/html-ppt-zhangzara-biennale-yellow" },
  },
  {
    id: "od:template:html-ppt-zhangzara-block-frame",
    kind: "template",
    name: "HTML PPT Zhangzara Block Frame",
    description:
      "BlockFrame — neobrutalist deck with pastel-neon color blocks and chunky black borders. Pop-graphic and design-led for indie SaaS launches, agency credentials, brand redesigns.",
    source: { path: "design-templates/html-ppt-zhangzara-block-frame" },
  },
  {
    id: "od:template:html-ppt-zhangzara-blue-professional",
    kind: "template",
    name: "HTML PPT Zhangzara Blue Professional",
    description:
      "Blue Professional — cream paper background with electric cobalt blue accents; clean modern professional. For B2B SaaS pitches, consulting deliverables, advisory updates, investor reports.",
    source: { path: "design-templates/html-ppt-zhangzara-blue-professional" },
  },
  {
    id: "od:template:html-ppt-zhangzara-bold-poster",
    kind: "template",
    name: "HTML PPT Zhangzara Bold Poster",
    description:
      "Bold Poster — editorial poster aesthetic with massive Shrikhand display and a single fire-engine red accent. For magazine-cover brand manifestos and editorial / cultural pitches.",
    source: { path: "design-templates/html-ppt-zhangzara-bold-poster" },
  },
  {
    id: "od:template:html-ppt-zhangzara-broadside",
    kind: "template",
    name: "HTML PPT Zhangzara Broadside",
    description:
      "Broadside — dark editorial canvas with a single fire orange accent and bilingual Latin/Chinese type stack. For manifestos, magazine pitches, design talks, bilingual EN/CN decks.",
    source: { path: "design-templates/html-ppt-zhangzara-broadside" },
  },
  {
    id: "od:template:html-ppt-zhangzara-capsule",
    kind: "template",
    name: "HTML PPT Zhangzara Capsule",
    description:
      "Capsule — modular pill-shaped cards on warm bone with a full pastel-pop palette. For lifestyle brands, creator portfolios, DTC launches, beauty / wellness, agency credentials.",
    source: { path: "design-templates/html-ppt-zhangzara-capsule" },
  },
  {
    id: "od:template:html-ppt-zhangzara-cartesian",
    kind: "template",
    name: "HTML PPT Zhangzara Cartesian",
    description:
      "Cartesian — quiet warm-neutral palette with classical Playfair serifs; tasteful and unhurried. For investment theses, white papers, advisory work, longform research, gallery decks.",
    source: { path: "design-templates/html-ppt-zhangzara-cartesian" },
  },
  {
    id: "od:template:html-ppt-zhangzara-cobalt-grid",
    kind: "template",
    name: "HTML PPT Zhangzara Cobalt Grid",
    description:
      "Cobalt Grid — electric cobalt italic serifs on a graph-paper canvas with stair-stepped pixel-glitch decorations. For design / research bulletins, art publications, curated trend reports.",
    source: { path: "design-templates/html-ppt-zhangzara-cobalt-grid" },
  },
  {
    id: "od:template:html-ppt-zhangzara-coral",
    kind: "template",
    name: "HTML PPT Zhangzara Coral",
    description:
      "Coral — cream and coral on near-black, set in oversized Bebas Neue. Warm-graphic editorial for fashion, beauty, fitness, F&B, lifestyle brands, agency credentials.",
    source: { path: "design-templates/html-ppt-zhangzara-coral" },
  },
  {
    id: "od:template:html-ppt-zhangzara-creative-mode",
    kind: "template",
    name: "HTML PPT Zhangzara Creative Mode",
    description:
      "Creative Mode — cream paper canvas with confident multi-color accents and Archivo Black display. For creative agency pitches, design studio decks, ad credentials, brand creative reviews.",
    source: { path: "design-templates/html-ppt-zhangzara-creative-mode" },
  },
  {
    id: "od:template:html-ppt-zhangzara-daisy-days",
    kind: "template",
    name: "HTML PPT Zhangzara Daisy Days",
    description:
      "Daisy Days — cheerful pastel deck with hand-drawn daisies, stars, and rainbows. Friendly, soft, and warm for educational content, kids and family, wellness, community workshops.",
    source: { path: "design-templates/html-ppt-zhangzara-daisy-days" },
  },
  {
    id: "od:template:html-ppt-zhangzara-editorial-tri-tone",
    kind: "template",
    name: "HTML PPT Zhangzara Editorial Tri Tone",
    description:
      "Editorial Tri-Tone — three-color editorial: dusty pink, mustard cream, deep burgundy; Bricolage + Instrument Serif. For fashion-magazine spreads, brand decks, lifestyle media.",
    source: { path: "design-templates/html-ppt-zhangzara-editorial-tri-tone" },
  },
  {
    id: "od:template:html-ppt-zhangzara-grove",
    kind: "template",
    name: "HTML PPT Zhangzara Grove",
    description:
      "Grove — forest-green canvas with cream type, classical Playfair serifs, single rust accent. For sustainability and wellness brands, outdoor products, wineries, advisory deliverables.",
    source: { path: "design-templates/html-ppt-zhangzara-grove" },
  },
  {
    id: "od:template:html-ppt-zhangzara-long-table",
    kind: "template",
    name: "HTML PPT Zhangzara Long Table",
    description:
      "Long Table — warm cream and rust-red supper-club aesthetic with bold uppercase grotesk headlines and italic Fraunces. For supper clubs, dinner series, lifestyle and wine brands.",
    source: { path: "design-templates/html-ppt-zhangzara-long-table" },
  },
  {
    id: "od:template:html-ppt-zhangzara-mat",
    kind: "template",
    name: "HTML PPT Zhangzara Mat",
    description:
      "Mat — dark sage canvas with bone paper and burnt-orange accent; mid-century modern with wood undertones. For architecture/interior brands, ceramics, craft, furniture, advisory decks.",
    source: { path: "design-templates/html-ppt-zhangzara-mat" },
  },
  {
    id: "od:template:html-ppt-zhangzara-monochrome",
    kind: "template",
    name: "HTML PPT Zhangzara Monochrome",
    description:
      "Monochrome — ivory ledger paper with all-black type; Lora serif headlines, Jost body, no color. For research synthesis, white papers, longform reports, bilingual EN/CN deliverables.",
    source: { path: "design-templates/html-ppt-zhangzara-monochrome" },
  },
  {
    id: "od:template:html-ppt-zhangzara-neo-grid-bold",
    kind: "template",
    name: "HTML PPT Zhangzara Neo Grid Bold",
    description:
      "Neo-Grid Bold — editorial neo-brutalism with a single neon yellow accent on off-white paper. For design-led pitches, brand work, founder talks, conference keynotes.",
    source: { path: "design-templates/html-ppt-zhangzara-neo-grid-bold" },
  },
  {
    id: "od:template:html-ppt-zhangzara-peoples-platform",
    kind: "template",
    name: "HTML PPT Zhangzara Peoples Platform",
    description:
      "People's Platform (Block & Bold) — activist poster energy: blue, orange, red on cream, with Alfa Slab + Caveat Brush. For cultural commentary, manifestos, civic decks, campaign pitches.",
    source: { path: "design-templates/html-ppt-zhangzara-peoples-platform" },
  },
  {
    id: "od:template:html-ppt-zhangzara-pin-and-paper",
    kind: "template",
    name: "HTML PPT Zhangzara Pin And Paper",
    description:
      "Pin & Paper — yellow paper with safety-pin illustrations, ink-blue handwritten Caveat, paper-grain texture. For qualitative research, founder reflections, longform brand stories.",
    source: { path: "design-templates/html-ppt-zhangzara-pin-and-paper" },
  },
  {
    id: "od:template:html-ppt-zhangzara-pink-script",
    kind: "template",
    name: "HTML PPT Zhangzara Pink Script",
    description:
      "Pink Script (After Hours) — black canvas, hot pink accent, pearl-cream paper, Instrument Serif. Late-night editorial luxury for fashion, creator brands, nightlife, and luxury reveals.",
    source: { path: "design-templates/html-ppt-zhangzara-pink-script" },
  },
  {
    id: "od:template:html-ppt-zhangzara-playful",
    kind: "template",
    name: "HTML PPT Zhangzara Playful",
    description:
      "Playful — sun-warm peach background with Syne display: a friendly indie launch deck. For creator portfolios, indie product launches, lifestyle brands, small-business pitches.",
    source: { path: "design-templates/html-ppt-zhangzara-playful" },
  },
  {
    id: "od:template:html-ppt-zhangzara-raw-grid",
    kind: "template",
    name: "HTML PPT Zhangzara Raw Grid",
    description:
      "Raw Grid — neo-brutalist deck with thick borders, offset shadows, and a pink/sage/ink palette. For founder pitches, accelerator demos, brand decks, indie launches, creator portfolios.",
    source: { path: "design-templates/html-ppt-zhangzara-raw-grid" },
  },
  {
    id: "od:template:html-ppt-zhangzara-retro-windows",
    kind: "template",
    name: "HTML PPT Zhangzara Retro Windows",
    description:
      "Retro Windows — Windows 95 chrome: gray title bars, MS Sans Serif, pixel typography, full nostalgia. For retro gaming, Y2K-aesthetic brands, creator portfolios, tech-history talks.",
    source: { path: "design-templates/html-ppt-zhangzara-retro-windows" },
  },
  {
    id: "od:template:html-ppt-zhangzara-sakura-chroma",
    kind: "template",
    name: "HTML PPT Zhangzara Sakura Chroma",
    description:
      "Sakura Chroma — vintage Japanese cassette-package aesthetic: cream paper, diagonal rainbow ribbons, condensed bold type, JIS-style spec checkboxes. For analog / kawaii-tech decks.",
    source: { path: "design-templates/html-ppt-zhangzara-sakura-chroma" },
  },
  {
    id: "od:template:html-ppt-zhangzara-scatterbrain",
    kind: "template",
    name: "HTML PPT Zhangzara Scatterbrain",
    description:
      "Scatterbrain — Post-it inspired: pastel sticky notes, Caveat handwriting, Shrikhand + Zilla Slab. For brainstorms, workshops, creative-agency credentials, ideation pitches.",
    source: { path: "design-templates/html-ppt-zhangzara-scatterbrain" },
  },
  {
    id: "od:template:html-ppt-zhangzara-signal",
    kind: "template",
    name: "HTML PPT Zhangzara Signal",
    description:
      "Signal — deep navy canvas with bone paper and a single muted-gold accent; institutional with quiet weight. For investor decks, board presentations, consulting deliverables, legal briefs.",
    source: { path: "design-templates/html-ppt-zhangzara-signal" },
  },
  {
    id: "od:template:html-ppt-zhangzara-soft-editorial",
    kind: "template",
    name: "HTML PPT Zhangzara Soft Editorial",
    description:
      "Soft Editorial — Cormorant Garamond serif on warm paper with sage, blush, and lemon accents. For literary brand stories, gallery decks, advisory deliverables, lifestyle media.",
    source: { path: "design-templates/html-ppt-zhangzara-soft-editorial" },
  },
  {
    id: "od:template:html-ppt-zhangzara-stencil-tablet",
    kind: "template",
    name: "HTML PPT Zhangzara Stencil Tablet",
    description:
      "Stencil & Tablet — bone paper with stencil-cut headlines and a six-color earth palette. Archaeology meets brand: museum decks, art/architecture brands, heritage and craft work.",
    source: { path: "design-templates/html-ppt-zhangzara-stencil-tablet" },
  },
  {
    id: "od:template:html-ppt-zhangzara-studio",
    kind: "template",
    name: "HTML PPT Zhangzara Studio",
    description:
      "Studio — black canvas with electric-yellow type; high-voltage design studio aesthetic. For studio credentials, creative agency pitches, brand showcases, fashion / sneaker work.",
    source: { path: "design-templates/html-ppt-zhangzara-studio" },
  },
  {
    id: "od:template:html-ppt-zhangzara-vellum",
    kind: "template",
    name: "HTML PPT Zhangzara Vellum",
    description:
      "Vellum — deep navy canvas with warm-yellow italic Cormorant serifs and a single dusty teal accent. Quiet, scholarly aesthetic for research synthesis, white papers, advisory work.",
    source: { path: "design-templates/html-ppt-zhangzara-vellum" },
  },
  {
    id: "od:template:hyperframes",
    kind: "template",
    name: "Hyperframes",
    description:
      "HTML video composition skill — captions, voiceover, audio-reactive animation, scene transitions, and timing in HyperFrames HTML. For CLI commands see hyperframes-cli.",
    source: { path: "design-templates/hyperframes" },
  },
  {
    id: "od:template:ib-pitch-book",
    kind: "template",
    name: "Ib Pitch Book",
    description:
      "Investment-banking pitch book — trading comps, precedent transactions, valuation football field, DCF sensitivity, strategic-options matrix. For Board / sell-side discussion materials.",
    source: { path: "design-templates/ib-pitch-book" },
  },
  {
    id: "od:template:image-poster",
    kind: "template",
    name: "Image Poster",
    description:
      "Single-image generation skill for posters, key art, and editorial illustrations. Defaults to gpt-image-2 but is provider-agnostic — the same workflow drives Flux, Imagen, or Midjourney via the active upstream tooling. Output is one or mo…",
    source: { path: "design-templates/image-poster" },
  },
  {
    id: "od:template:invoice",
    kind: "template",
    name: "Invoice",
    description:
      "A printable invoice page — sender + recipient block, line items table, tax breakdown, totals, and payment instructions.",
    source: { path: "design-templates/invoice" },
  },
  {
    id: "od:template:kami-deck",
    kind: "template",
    name: "Kami Deck",
    description:
      "Produce a print-grade slide deck in the kami (紙 / 纸) design system — warm parchment background (or ink-blue for cover / chapter slides), serif at one weight, ink-blue accent ≤ 5% per slide, no italic. Horizontal magazine swipe pagination…",
    source: { path: "design-templates/kami-deck" },
  },
  {
    id: "od:template:kami-landing",
    kind: "template",
    name: "Kami Landing",
    description:
      "Produce a print-grade single-page kami (紙 / 纸) document — warm parchment canvas, ink-blue accent, serif at one weight, no italic, no cool grays. The output reads like a professional white paper or studio one-pager, not an app UI. Multili…",
    source: { path: "design-templates/kami-landing" },
  },
  {
    id: "od:template:kanban-board",
    kind: "template",
    name: "Kanban Board",
    description:
      "Kanban / task board with columns (To do / In progress / In review / Done), draggable-looking cards, assignee avatars, swimlanes, and a top filter bar.",
    source: { path: "design-templates/kanban-board" },
  },
  {
    id: "od:template:last30days",
    kind: "template",
    name: "Last30days",
    description:
      "Recent community and social trend research over the last 30 days.",
    source: { path: "design-templates/last30days" },
  },
  {
    id: "od:template:live-artifact",
    kind: "template",
    name: "Live Artifact",
    description:
      "Create refreshable, auditable artifacts backed by connector or local data. Trigger when the user asks for live dashboards, refreshable reports, synced views, or reusable data-backed artifacts.",
    source: { path: "design-templates/live-artifact" },
  },
  {
    id: "od:template:live-dashboard",
    kind: "template",
    name: "Live Dashboard",
    description:
      "Notion-style team dashboard as a Live Artifact — KPIs, 7-day sparkline, activity feed, and a linked-database task table wired to Notion via Composio. Refreshable, with mock fallback.",
    source: { path: "design-templates/live-dashboard" },
  },
  {
    id: "od:template:magazine-poster",
    kind: "template",
    name: "Magazine Poster",
    description:
      "An editorial-style poster — newsprint paper, dateline, oversized serif headline with a struck-through word and italic accent, a 2-column body block, and 6 numbered sections with annotated pull-quote captions. Reads like a Sunday-paper fu…",
    source: { path: "design-templates/magazine-poster" },
  },
  {
    id: "od:template:meeting-notes",
    kind: "template",
    name: "Meeting Notes",
    description:
      'Meeting notes page — title bar with attendees, agenda checklist, decisions block, action items table with owners + dates, and a "next meeting" footer.',
    source: { path: "design-templates/meeting-notes" },
  },
  {
    id: "od:template:mobile-onboarding",
    kind: "template",
    name: "Mobile Onboarding",
    description:
      "A multi-screen mobile onboarding flow rendered as three phone frames side by side — splash, value-prop, sign-in. Status bar, swipe dots, primary CTA.",
    source: { path: "design-templates/mobile-onboarding" },
  },
  {
    id: "od:template:motion-frames",
    kind: "template",
    name: "Motion Frames",
    description:
      "A single-frame motion-design composition with looping CSS animations — rotating type ring, animated globe, ticking timer, parallax labels. Renders as a hero video poster you can hand straight to HyperFrames or any keyframe-based exporter.",
    source: { path: "design-templates/motion-frames" },
  },
  {
    id: "od:template:open-design-landing",
    kind: "template",
    name: "Editorial Landing",
    description:
      "Single-page editorial landing site in the Atelier Zero visual language (Monocle / Apartamento / Études collage). Composes from a typed inputs.json with optional gpt-image-2 assets.",
    source: { path: "design-templates/open-design-landing" },
  },
  {
    id: "od:template:open-design-landing-deck",
    kind: "template",
    name: "Editorial Landing Deck",
    description:
      "Single-file slide deck in the Atelier Zero visual language — warm-paper, italic-serif emphasis, coral terminating dots, surreal collage. Horizontal swipe + ESC overview grid.",
    source: { path: "design-templates/open-design-landing-deck" },
  },
  {
    id: "od:template:orbit-general",
    kind: "template",
    name: "Orbit General",
    description:
      "Open Orbit daily digest — pulls 24h activity from every connected connector (GitHub, Linear, Notion, Slack, …) into a bento-grid dashboard. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-general" },
  },
  {
    id: "od:template:orbit-github",
    kind: "template",
    name: "Orbit Github",
    description:
      "Open Orbit GitHub digest — 24h of PRs, reviews, issues, CI, and merges rendered in GitHub's native Notifications + PR-diff visual language. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-github" },
  },
  {
    id: "od:template:orbit-gmail",
    kind: "template",
    name: "Orbit Gmail",
    description:
      "Open Orbit Gmail digest — 24h of inbox activity (replies, mentions, cc, bulk) rendered as the Orbit Daily Digest email inside Gmail's reading view. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-gmail" },
  },
  {
    id: "od:template:orbit-linear",
    kind: "template",
    name: "Orbit Linear",
    description:
      "Open Orbit Linear digest — 24h of issue movement, status changes, assignments, and cycle progress in Linear's native Inbox + cycle visual language. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-linear" },
  },
  {
    id: "od:template:orbit-notion",
    kind: "template",
    name: "Orbit Notion",
    description:
      "Open Orbit Notion digest — 24h of doc edits, comments, mentions, and database row changes rendered as a native Notion page. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-notion" },
  },
  {
    id: "od:template:pm-spec",
    kind: "template",
    name: "Pm Spec",
    description:
      "Product spec / PRD as a single page — problem, success metrics, scope, user stories, design notes, rollout plan, open questions.",
    source: { path: "design-templates/pm-spec" },
  },
  {
    id: "od:template:pricing-page",
    kind: "template",
    name: "Pricing Page",
    description:
      "A standalone pricing page — header, plan tiers, feature comparison table, and an FAQ.",
    source: { path: "design-templates/pricing-page" },
  },
  {
    id: "od:template:replit-deck",
    kind: "template",
    name: "Replit Deck",
    description:
      "Single-file horizontal-swipe HTML deck in the style of Replit Slides's landing-page template gallery. Eight distinct themes (helix, holm, vance, bevel, world-dark, world-mint, atlas, bluehouse) — each a complete visual system (palette +…",
    source: { path: "design-templates/replit-deck" },
  },
  {
    id: "od:template:saas-landing",
    kind: "template",
    name: "Saas Landing",
    description:
      "Single-page SaaS landing with hero, features, social proof, pricing, and CTA. Respects the active DESIGN.md color/typography/layout tokens.",
    source: { path: "design-templates/saas-landing" },
  },
  {
    id: "od:template:simple-deck",
    kind: "template",
    name: "Simple Deck",
    description:
      "Single-file horizontal-swipe HTML deck. Built by copying the seed `assets/template.html` (which carries the proven 5-rule iframe nav script) and pasting slide layouts from `references/layouts.md`. Pitch decks, product overviews, study ma…",
    source: { path: "design-templates/simple-deck" },
  },
  {
    id: "od:template:social-carousel",
    kind: "template",
    name: "Social Carousel",
    description:
      'A three-card social-media carousel laid out as 1080×1080 squares — three cinematic, on-brand panels with display headlines that connect across the series ("onwards." → "to the next one." → "looking ahead."). Each card has a brand mark, a…',
    source: { path: "design-templates/social-carousel" },
  },
  {
    id: "od:template:social-media-dashboard",
    kind: "template",
    name: "Social Media Dashboard",
    description:
      'Creator-facing social media analytics dashboard in a single HTML file. A platform switcher (X / LinkedIn / YouTube / Instagram), a row of KPI cards (followers, engagement rate, likes, reposts), a follower-growth chart, a "top post this w…',
    source: { path: "design-templates/social-media-dashboard" },
  },
  {
    id: "od:template:social-media-matrix-tracker-template",
    kind: "template",
    name: "Social Media Matrix Tracker Template",
    description: "社媒矩阵数据追踪面板模板（Social Media Matrix Tracker）。",
    source: { path: "design-templates/social-media-matrix-tracker-template" },
  },
  {
    id: "od:template:sprite-animation",
    kind: "template",
    name: "Sprite Animation",
    description:
      "A pixel / sprite-style animated explainer slide — full-bleed cream stage, bold display year, animated pixel-art mascot (e.g. Hanafuda card, mushroom, or 8-bit console), kinetic Japanese display type, ticking timeline ribbon. Reads like a…",
    source: { path: "design-templates/sprite-animation" },
  },
  {
    id: "od:template:team-okrs",
    kind: "template",
    name: "Team Okrs",
    description:
      'OKR tracker page — quarter banner, three objectives with their key results as progress bars, owner avatars, status pills, and a "this quarter at a glance" sidebar.',
    source: { path: "design-templates/team-okrs" },
  },
  {
    id: "od:template:trading-analysis-dashboard-template",
    kind: "template",
    name: "Trading Analysis Dashboard Template",
    description:
      "Professional trading analysis dashboard template (single-file HTML) with light/dark theme switch, dense market panels, chart interactions, demo/live playback, and command palette behavior.",
    source: { path: "design-templates/trading-analysis-dashboard-template" },
  },
  {
    id: "od:template:tweaks",
    kind: "template",
    name: "Tweaks",
    description:
      "Wrap any HTML artifact with a side panel of live, parameterized controls — accent color, type scale, density, motion, theme — that rewrite CSS custom properties in real time and persist to localStorage. Lets the user explore variants of…",
    source: { path: "design-templates/tweaks" },
  },
  {
    id: "od:template:video-shortform",
    kind: "template",
    name: "Video Shortform",
    description:
      "Short-form video generation skill — 3-10 second clips for product reveals, motion teasers, ambient loops. Defaults to Seedance 2 but works the same with Kling 3 / 4, Veo 3 or Sora 2. Output is one MP4 saved to the project folder. When th…",
    source: { path: "design-templates/video-shortform" },
  },
  {
    id: "od:template:waitlist-page",
    kind: "template",
    name: "Waitlist Page",
    description:
      "Minimal pre-launch landing with email capture, brand logo, and optional decorative layer. Reads DESIGN.md for colors, typography, and layout rules.",
    source: { path: "design-templates/waitlist-page" },
  },
  {
    id: "od:template:web-prototype",
    kind: "template",
    name: "Web Prototype",
    description:
      "General-purpose desktop web prototype. Single self-contained HTML file built by copying the seed `assets/template.html` and pasting section layouts from `references/layouts.md`. Default for any landing / marketing / docs / SaaS page when…",
    source: { path: "design-templates/web-prototype" },
  },
  {
    id: "od:template:web-prototype-taste-brutalist",
    kind: "template",
    name: "Web Prototype Taste Brutalist",
    description:
      "Swiss industrial-print web prototype. Newsprint canvas, monolithic black grotesque, viewport-bleeding numerals, hairline grid dividers, hazard-red accent, ASCII syntax decoration. Distilled from Leonxlnx/taste-skill `brutalist-skill` (Sw…",
    source: { path: "design-templates/web-prototype-taste-brutalist" },
  },
  {
    id: "od:template:web-prototype-taste-soft",
    kind: "template",
    name: "Web Prototype Taste Soft",
    description:
      "Apple-tier soft web prototype. Silver/cream canvas, double-bezel cards, button-in-button CTAs, generous squircle radii, spring motion, ambient mesh. Distilled from Leonxlnx/taste-skill `soft-skill` + sections 4–8 of `taste-skill`.",
    source: { path: "design-templates/web-prototype-taste-soft" },
  },
  {
    id: "od:template:wireframe-sketch",
    kind: "template",
    name: "Wireframe Sketch",
    description:
      "A hand-drawn wireframe exploration — graph-paper background, marker / pencil tone, multiple tab labels for variants, sticky-note annotations, scribbled chart placeholders, hatched fills. Reads like a designer's whiteboard before any pixe…",
    source: { path: "design-templates/wireframe-sketch" },
  },
  {
    id: "od:template:x-research",
    kind: "template",
    name: "X Research",
    description:
      "X/Twitter public sentiment research for recent market, company, product, or community discourse.",
    source: { path: "design-templates/x-research" },
  },
  {
    id: "od:design-system:dashboard",
    kind: "design-system",
    name: "Dashboard",
    description:
      "Dark cloud-platform aesthetic with modular grids, glass-like panels, and strong data hierarchy for productivity dashboards.",
    source: { path: "design-systems/dashboard" },
  },
  {
    id: "od:design-system:trading-terminal",
    kind: "design-system",
    name: "Trading Terminal",
    description:
      "Bloomberg-style financial trading terminal: dark-only, data-dense, with cyan and coral buy/sell signals readable at a glance.",
    source: { path: "design-systems/trading-terminal" },
  },
  {
    id: "od:design-system:warm-editorial",
    kind: "design-system",
    name: "Warm Editorial",
    description:
      "Serif-led magazine aesthetic with terracotta accents on warm off-white paper for readable narrative pages, zines, and reports.",
    source: { path: "design-systems/warm-editorial" },
  },
  {
    id: "od:design-system:editorial",
    kind: "design-system",
    name: "Editorial",
    description:
      "Magazine-inspired editorial layout with refined serif typography, structured grids, and elegant reading experiences.",
    source: { path: "design-systems/editorial" },
  },
  {
    id: "od:design-system:mono",
    kind: "design-system",
    name: "Mono",
    description:
      "Monospace-driven, matrix-inspired design with high-contrast elements, compact density, and a hacker-chic aesthetic.",
    source: { path: "design-systems/mono" },
  },
  {
    id: "od:design-system:apple",
    kind: "design-system",
    name: "Apple",
    description:
      "Consumer electronics design system with premium white space, SF Pro-style typography, and cinematic imagery.",
    source: { path: "design-systems/apple" },
  },
  {
    id: "od:design-system:agentic",
    kind: "design-system",
    name: "Agentic",
    description:
      "Conversational AI-first interface with minimal controls, clear outcomes, and delegated task flows for agentic workflows.",
    source: { path: "design-systems/agentic" },
  },
  {
    id: "od:design-system:airbnb",
    kind: "design-system",
    name: "Airbnb",
    description:
      "Travel marketplace. Warm coral accent, photography-driven, rounded UI.",
    source: { path: "design-systems/airbnb" },
  },
  {
    id: "od:design-system:airtable",
    kind: "design-system",
    name: "Airtable",
    description:
      "Spreadsheet-database hybrid. Colorful, friendly, structured data aesthetic.",
    source: { path: "design-systems/airtable" },
  },
  {
    id: "od:design-system:ant",
    kind: "design-system",
    name: "Ant",
    description:
      "Structured, enterprise-focused design system emphasizing clarity, consistency, and efficiency for data-dense web applications.",
    source: { path: "design-systems/ant" },
  },
  {
    id: "od:design-system:application",
    kind: "design-system",
    name: "Application",
    description:
      "App dashboard with purple-themed aesthetic, top-bar navigation, card-based layouts, and developer-first workflows.",
    source: { path: "design-systems/application" },
  },
  {
    id: "od:design-system:arc",
    kind: "design-system",
    name: "Arc",
    description:
      '"The browser that browses for you." Translucent surfaces, gradient warmth, sidebar-first layout.',
    source: { path: "design-systems/arc" },
  },
  {
    id: "od:design-system:artistic",
    kind: "design-system",
    name: "Artistic",
    description:
      "High-contrast, expressive style with creative typography and bold color choices for visually striking interfaces.",
    source: { path: "design-systems/artistic" },
  },
  {
    id: "od:design-system:atelier-zero",
    kind: "design-system",
    name: "Atelier Zero",
    description:
      "A magazine-grade, collage-driven visual system: warm paper canvas, surreal.",
    source: { path: "design-systems/atelier-zero" },
  },
  {
    id: "od:design-system:bento",
    kind: "design-system",
    name: "Bento",
    description:
      "Modular grid layout with card-like blocks, clear hierarchy, soft spacing, and subtle visual contrast for organized, scannable interfaces.",
    source: { path: "design-systems/bento" },
  },
  {
    id: "od:design-system:binance",
    kind: "design-system",
    name: "Binance",
    description:
      "Crypto exchange. Bold yellow accent on monochrome, trading-floor urgency.",
    source: { path: "design-systems/binance" },
  },
  {
    id: "od:design-system:bmw",
    kind: "design-system",
    name: "Bmw",
    description:
      "Luxury automotive. Dark premium surfaces, precise German engineering aesthetic.",
    source: { path: "design-systems/bmw" },
  },
  {
    id: "od:design-system:bmw-m",
    kind: "design-system",
    name: "Bmw M",
    description:
      "Motorsport performance sub-brand. Near-black cockpit surfaces, BMW M tricolor accents, sharp engineering geometry.",
    source: { path: "design-systems/bmw-m" },
  },
  {
    id: "od:design-system:bold",
    kind: "design-system",
    name: "Bold",
    description:
      "Strong visual presence with heavyweight typography, high-contrast colors, and commanding layouts.",
    source: { path: "design-systems/bold" },
  },
  {
    id: "od:design-system:brutalism",
    kind: "design-system",
    name: "Brutalism",
    description:
      "Raw, anti-design aesthetic inspired by concrete architecture with unadorned elements, jarring layouts, and functional minimalism.",
    source: { path: "design-systems/brutalism" },
  },
  {
    id: "od:design-system:bugatti",
    kind: "design-system",
    name: "Bugatti",
    description:
      "Hypercar brand. Cinema-black canvas, monochrome austerity, monumental display type.",
    source: { path: "design-systems/bugatti" },
  },
  {
    id: "od:design-system:cafe",
    kind: "design-system",
    name: "Cafe",
    description:
      "Cozy cafe-inspired interface with warm tones, soft typography, and clean layouts for a relaxed browsing experience.",
    source: { path: "design-systems/cafe" },
  },
  {
    id: "od:design-system:cal",
    kind: "design-system",
    name: "Cal",
    description:
      "Open-source scheduling. Clean neutral UI, developer-oriented simplicity.",
    source: { path: "design-systems/cal" },
  },
  {
    id: "od:design-system:canva",
    kind: "design-system",
    name: "Canva",
    description:
      "Visual creation platform. Vivid purple-blue gradient, generous spacing, friendly geometry.",
    source: { path: "design-systems/canva" },
  },
  {
    id: "od:design-system:cisco",
    kind: "design-system",
    name: "Cisco",
    description:
      "Enterprise infrastructure brand. Dark trust surfaces, Cisco Blue signal, technical clarity.",
    source: { path: "design-systems/cisco" },
  },
  {
    id: "od:design-system:claude",
    kind: "design-system",
    name: "Claude",
    description:
      "Anthropic's AI assistant. Warm terracotta accent, clean editorial layout.",
    source: { path: "design-systems/claude" },
  },
  {
    id: "od:design-system:clay",
    kind: "design-system",
    name: "Clay",
    description:
      "Creative agency. Organic shapes, soft gradients, art-directed layout.",
    source: { path: "design-systems/clay" },
  },
  {
    id: "od:design-system:claymorphism",
    kind: "design-system",
    name: "Claymorphism",
    description:
      "Soft, rounded 3D-like shapes mimicking malleable clay with playful, puffy elements and colorful surfaces.",
    source: { path: "design-systems/claymorphism" },
  },
  {
    id: "od:design-system:clean",
    kind: "design-system",
    name: "Clean",
    description:
      "Simplicity-focused design with ample whitespace, legible typography, and a limited color palette to reduce visual clutter.",
    source: { path: "design-systems/clean" },
  },
  {
    id: "od:design-system:clickhouse",
    kind: "design-system",
    name: "Clickhouse",
    description:
      "Fast analytics database. Yellow-accented, technical documentation style.",
    source: { path: "design-systems/clickhouse" },
  },
  {
    id: "od:design-system:cohere",
    kind: "design-system",
    name: "Cohere",
    description:
      "Enterprise AI platform. Vibrant gradients, data-rich dashboard aesthetic.",
    source: { path: "design-systems/cohere" },
  },
  {
    id: "od:design-system:coinbase",
    kind: "design-system",
    name: "Coinbase",
    description:
      "Crypto exchange. Clean blue identity, trust-focused, institutional feel.",
    source: { path: "design-systems/coinbase" },
  },
  {
    id: "od:design-system:colorful",
    kind: "design-system",
    name: "Colorful",
    description:
      "Vibrant, high-contrast palettes and gradients for engaging, memorable, and modern user experiences.",
    source: { path: "design-systems/colorful" },
  },
  {
    id: "od:design-system:composio",
    kind: "design-system",
    name: "Composio",
    description:
      "Tool integration platform. Modern dark with colorful integration icons.",
    source: { path: "design-systems/composio" },
  },
  {
    id: "od:design-system:contemporary",
    kind: "design-system",
    name: "Contemporary",
    description:
      "Current-era minimalist design with bento grids, dark mode support, and high-performance accessible layouts.",
    source: { path: "design-systems/contemporary" },
  },
  {
    id: "od:design-system:corporate",
    kind: "design-system",
    name: "Corporate",
    description:
      "Professional, brand-aligned design with structured grids, minimalist layouts, and consistent enterprise patterns.",
    source: { path: "design-systems/corporate" },
  },
  {
    id: "od:design-system:cosmic",
    kind: "design-system",
    name: "Cosmic",
    description:
      "Futuristic sci-fi aesthetic with dark themes, vibrant neon accents, and immersive spatial elements.",
    source: { path: "design-systems/cosmic" },
  },
  {
    id: "od:design-system:creative",
    kind: "design-system",
    name: "Creative",
    description:
      "Playful, character-driven design with expressive typography and bold graphics for landing pages and creative projects.",
    source: { path: "design-systems/creative" },
  },
  {
    id: "od:design-system:cursor",
    kind: "design-system",
    name: "Cursor",
    description:
      "AI-first code editor. Sleek dark interface, gradient accents.",
    source: { path: "design-systems/cursor" },
  },
  {
    id: "od:design-system:default",
    kind: "design-system",
    name: "Default",
    description: "A clean, product-oriented default.",
    source: { path: "design-systems/default" },
  },
  {
    id: "od:design-system:discord",
    kind: "design-system",
    name: "Discord",
    description:
      "Voice / chat platform. Deep blurple, dark-first surfaces, playful accent moments.",
    source: { path: "design-systems/discord" },
  },
  {
    id: "od:design-system:dithered",
    kind: "design-system",
    name: "Dithered",
    description:
      "Dot-pattern rendering technique that simulates shades with a limited palette for nostalgic, retro, high-contrast visuals.",
    source: { path: "design-systems/dithered" },
  },
  {
    id: "od:design-system:doodle",
    kind: "design-system",
    name: "Doodle",
    description:
      "Hand-drawn, sketch-like style with doodles, handwritten fonts, and imperfect lines for a playful, informal feel.",
    source: { path: "design-systems/doodle" },
  },
  {
    id: "od:design-system:dramatic",
    kind: "design-system",
    name: "Dramatic",
    description:
      "High-contrast, theatrical design with bold layouts, immersive visuals, and unconventional compositions that command attention.",
    source: { path: "design-systems/dramatic" },
  },
  {
    id: "od:design-system:duolingo",
    kind: "design-system",
    name: "Duolingo",
    description:
      "Language-learning platform. Bright owl green, chunky shadows, gamified joy.",
    source: { path: "design-systems/duolingo" },
  },
  {
    id: "od:design-system:elegant",
    kind: "design-system",
    name: "Elegant",
    description:
      "Graceful, refined aesthetic with delicate typography, minimal palettes, and polished layouts that exude sophistication.",
    source: { path: "design-systems/elegant" },
  },
  {
    id: "od:design-system:elevenlabs",
    kind: "design-system",
    name: "Elevenlabs",
    description:
      "AI voice platform. Dark cinematic UI, audio-waveform aesthetics.",
    source: { path: "design-systems/elevenlabs" },
  },
  {
    id: "od:design-system:energetic",
    kind: "design-system",
    name: "Energetic",
    description:
      "Dynamic, vibrant style with thick borders, geometric shapes, high-contrast colors, and expressive typography conveying motion and vitality.",
    source: { path: "design-systems/energetic" },
  },
  {
    id: "od:design-system:enterprise",
    kind: "design-system",
    name: "Enterprise",
    description:
      "Clean, high-contrast enterprise design for data-driven workflows with intuitive drag-and-drop patterns and structured layouts.",
    source: { path: "design-systems/enterprise" },
  },
  {
    id: "od:design-system:expo",
    kind: "design-system",
    name: "Expo",
    description:
      "React Native platform. Dark theme, tight letter-spacing, code-centric.",
    source: { path: "design-systems/expo" },
  },
  {
    id: "od:design-system:expressive",
    kind: "design-system",
    name: "Expressive",
    description:
      "Vibrant, personality-driven design with bold colors, playful graphics, and dynamic layouts that balance creativity with structure.",
    source: { path: "design-systems/expressive" },
  },
  {
    id: "od:design-system:fantasy",
    kind: "design-system",
    name: "Fantasy",
    description:
      "Game-inspired fantasy aesthetic with bold, premium visuals, rich color palettes, and immersive thematic elements.",
    source: { path: "design-systems/fantasy" },
  },
  {
    id: "od:design-system:ferrari",
    kind: "design-system",
    name: "Ferrari",
    description:
      "Luxury automotive. Chiaroscuro editorial, Ferrari Red accents, cinematic black.",
    source: { path: "design-systems/ferrari" },
  },
  {
    id: "od:design-system:figma",
    kind: "design-system",
    name: "Figma",
    description:
      "Collaborative design tool. Vibrant multi-color, playful yet professional.",
    source: { path: "design-systems/figma" },
  },
  {
    id: "od:design-system:flat",
    kind: "design-system",
    name: "Flat",
    description:
      "Two-dimensional minimalist style with vibrant colors, clean typography, and no 3D effects for fast, user-friendly interfaces.",
    source: { path: "design-systems/flat" },
  },
  {
    id: "od:design-system:framer",
    kind: "design-system",
    name: "Framer",
    description:
      "Website builder. Bold black and blue, motion-first, design-forward.",
    source: { path: "design-systems/framer" },
  },
  {
    id: "od:design-system:friendly",
    kind: "design-system",
    name: "Friendly",
    description:
      "Approachable, intuitive design with rounded elements, ample whitespace, and soft pastel color palettes.",
    source: { path: "design-systems/friendly" },
  },
  {
    id: "od:design-system:futuristic",
    kind: "design-system",
    name: "Futuristic",
    description:
      "Forward-looking design with tech-inspired typography, modern layouts, and a sleek, innovation-driven aesthetic.",
    source: { path: "design-systems/futuristic" },
  },
  {
    id: "od:design-system:github",
    kind: "design-system",
    name: "Github",
    description:
      "Code-forward platform. Functional density, blue-on-white precision, Primer foundations.",
    source: { path: "design-systems/github" },
  },
  {
    id: "od:design-system:glassmorphism",
    kind: "design-system",
    name: "Glassmorphism",
    description:
      "Frosted glass effect with translucent layers, subtle blur, and luminous borders for depth and modern elegance.",
    source: { path: "design-systems/glassmorphism" },
  },
  {
    id: "od:design-system:gradient",
    kind: "design-system",
    name: "Gradient",
    description:
      "Smooth color transitions and gradient-rich surfaces for modern, playful interfaces with visual depth.",
    source: { path: "design-systems/gradient" },
  },
  {
    id: "od:design-system:hashicorp",
    kind: "design-system",
    name: "Hashicorp",
    description:
      "Infrastructure automation. Enterprise-clean, black and white.",
    source: { path: "design-systems/hashicorp" },
  },
  {
    id: "od:design-system:hud",
    kind: "design-system",
    name: "Hud",
    description:
      "Fighter jet / helicopter head-up display. Phosphor green on near-black, all-caps data overlays, angular geometry. Zero ambiguity at speed and altitude.",
    source: { path: "design-systems/hud" },
  },
  {
    id: "od:design-system:huggingface",
    kind: "design-system",
    name: "Huggingface",
    description:
      "ML community hub. Sunny yellow accent, monospace identity, cheerful and dense.",
    source: { path: "design-systems/huggingface" },
  },
  {
    id: "od:design-system:ibm",
    kind: "design-system",
    name: "Ibm",
    description:
      "Enterprise technology. Carbon design system, structured blue palette.",
    source: { path: "design-systems/ibm" },
  },
  {
    id: "od:design-system:intercom",
    kind: "design-system",
    name: "Intercom",
    description:
      "Customer messaging. Friendly blue palette, conversational UI patterns.",
    source: { path: "design-systems/intercom" },
  },
  {
    id: "od:design-system:kami",
    kind: "design-system",
    name: "Kami",
    description:
      "Editorial paper system: warm parchment canvas, ink-blue accent, serif-led hierarchy. Built for resumes, one-pagers, white papers, portfolios, slide decks — anything that should feel like high-quality print rather than UI. Multilingual by…",
    source: { path: "design-systems/kami" },
  },
  {
    id: "od:design-system:kraken",
    kind: "design-system",
    name: "Kraken",
    description:
      "Crypto trading. Purple-accented dark UI, data-dense dashboards.",
    source: { path: "design-systems/kraken" },
  },
  {
    id: "od:design-system:lamborghini",
    kind: "design-system",
    name: "Lamborghini",
    description:
      "Supercar brand. True black surfaces, gold accents, dramatic uppercase typography.",
    source: { path: "design-systems/lamborghini" },
  },
  {
    id: "od:design-system:levels",
    kind: "design-system",
    name: "Levels",
    description:
      "Conversion-focused design that removes friction and guides users toward action through clarity, trust, and speed.",
    source: { path: "design-systems/levels" },
  },
  {
    id: "od:design-system:linear-app",
    kind: "design-system",
    name: "Linear App",
    description: "Project management. Ultra-minimal, precise, purple accent.",
    source: { path: "design-systems/linear-app" },
  },
  {
    id: "od:design-system:lingo",
    kind: "design-system",
    name: "Lingo",
    description:
      "Playful, minimal design with bright colors, rounded shapes, tactile 3D borders, and friendly illustrations for approachable interfaces.",
    source: { path: "design-systems/lingo" },
  },
  {
    id: "od:design-system:loom",
    kind: "design-system",
    name: "Loom",
    description:
      "Loom async video. Purple primary, friendly surfaces, video-first layout. Clean and professional without being corporate.",
    source: { path: "design-systems/loom" },
  },
  {
    id: "od:design-system:lovable",
    kind: "design-system",
    name: "Lovable",
    description:
      "AI full-stack builder. Playful gradients, friendly dev aesthetic.",
    source: { path: "design-systems/lovable" },
  },
  {
    id: "od:design-system:luxury",
    kind: "design-system",
    name: "Luxury",
    description:
      "High-end dark aesthetic with bold headings, monochromatic palette, and premium feel for luxury brand experiences.",
    source: { path: "design-systems/luxury" },
  },
  {
    id: "od:design-system:mastercard",
    kind: "design-system",
    name: "Mastercard",
    description:
      "Global payments network. Warm cream canvas, orbital pill shapes, editorial warmth.",
    source: { path: "design-systems/mastercard" },
  },
  {
    id: "od:design-system:material",
    kind: "design-system",
    name: "Material",
    description:
      "Google's Material Design with layered surfaces, dynamic theming, built-in motion, and responsive cross-platform patterns.",
    source: { path: "design-systems/material" },
  },
  {
    id: "od:design-system:meta",
    kind: "design-system",
    name: "Meta",
    description:
      "Tech retail store. Photography-first, binary light/dark surfaces, Meta Blue CTAs.",
    source: { path: "design-systems/meta" },
  },
  {
    id: "od:design-system:minimal",
    kind: "design-system",
    name: "Minimal",
    description:
      "Stripped-back design emphasizing whitespace, clean typography, and restrained color for maximum clarity and focus.",
    source: { path: "design-systems/minimal" },
  },
  {
    id: "od:design-system:minimax",
    kind: "design-system",
    name: "Minimax",
    description: "AI model provider. Bold dark interface with neon accents.",
    source: { path: "design-systems/minimax" },
  },
  {
    id: "od:design-system:mintlify",
    kind: "design-system",
    name: "Mintlify",
    description:
      "Documentation platform. Clean, green-accented, reading-optimized.",
    source: { path: "design-systems/mintlify" },
  },
  {
    id: "od:design-system:miro",
    kind: "design-system",
    name: "Miro",
    description:
      "Visual collaboration. Bright yellow accent, infinite canvas aesthetic.",
    source: { path: "design-systems/miro" },
  },
  {
    id: "od:design-system:mission-control",
    kind: "design-system",
    name: "Mission Control",
    description:
      "Space/aerospace mission monitoring. Dark command center, amber telemetry, monospace precision. Functional clarity above all else.",
    source: { path: "design-systems/mission-control" },
  },
  {
    id: "od:design-system:mistral-ai",
    kind: "design-system",
    name: "Mistral AI",
    description:
      "Open-weight LLM provider. French-engineered minimalism, purple-toned.",
    source: { path: "design-systems/mistral-ai" },
  },
  {
    id: "od:design-system:modern",
    kind: "design-system",
    name: "Modern",
    description:
      "Contemporary editorial style with serif typography, minimal palettes, and clean layouts for polished digital products.",
    source: { path: "design-systems/modern" },
  },
  {
    id: "od:design-system:mongodb",
    kind: "design-system",
    name: "Mongodb",
    description:
      "Document database. Green leaf branding, developer documentation focus.",
    source: { path: "design-systems/mongodb" },
  },
  {
    id: "od:design-system:neobrutalism",
    kind: "design-system",
    name: "Neobrutalism",
    description:
      "Modern take on brutalism with bold borders, vivid accent colors, and raw, high-contrast layouts on warm surfaces.",
    source: { path: "design-systems/neobrutalism" },
  },
  {
    id: "od:design-system:neon",
    kind: "design-system",
    name: "Neon",
    description:
      "Electric neon glow effects with high-contrast color pairings for bold, attention-grabbing interfaces.",
    source: { path: "design-systems/neon" },
  },
  {
    id: "od:design-system:neumorphism",
    kind: "design-system",
    name: "Neumorphism",
    description:
      "Soft, extruded UI elements with inner and outer shadows on monochromatic surfaces for a tactile, embedded look.",
    source: { path: "design-systems/neumorphism" },
  },
  {
    id: "od:design-system:nike",
    kind: "design-system",
    name: "Nike",
    description:
      "Athletic retail. Monochrome UI, massive uppercase type, full-bleed photography.",
    source: { path: "design-systems/nike" },
  },
  {
    id: "od:design-system:notion",
    kind: "design-system",
    name: "Notion",
    description:
      "All-in-one workspace. Warm minimalism, serif headings, soft surfaces.",
    source: { path: "design-systems/notion" },
  },
  {
    id: "od:design-system:nvidia",
    kind: "design-system",
    name: "Nvidia",
    description:
      "GPU computing. Green-black energy, technical power aesthetic.",
    source: { path: "design-systems/nvidia" },
  },
  {
    id: "od:design-system:ollama",
    kind: "design-system",
    name: "Ollama",
    description: "Run LLMs locally. Terminal-first, monochrome simplicity.",
    source: { path: "design-systems/ollama" },
  },
  {
    id: "od:design-system:openai",
    kind: "design-system",
    name: "Openai",
    description:
      "Calm, near-monochrome system anchored in deep teal-black with generous white space and editorial typography.",
    source: { path: "design-systems/openai" },
  },
  {
    id: "od:design-system:opencode-ai",
    kind: "design-system",
    name: "Opencode AI",
    description: "AI coding platform. Developer-centric dark theme.",
    source: { path: "design-systems/opencode-ai" },
  },
  {
    id: "od:design-system:pacman",
    kind: "design-system",
    name: "Pacman",
    description:
      "Retro arcade-inspired design with pixel fonts, dotted borders, playful high-contrast colors, and 8-bit game aesthetics.",
    source: { path: "design-systems/pacman" },
  },
  {
    id: "od:design-system:paper",
    kind: "design-system",
    name: "Paper",
    description:
      "Paper-textured, print-inspired design with minimal colors, clean serif/sans typography, and tactile surface qualities.",
    source: { path: "design-systems/paper" },
  },
  {
    id: "od:design-system:perplexity",
    kind: "design-system",
    name: "Perplexity",
    description:
      "Conversational AI search engine. Deep-dark canvas, sharp typography, single violet accent, dense information hierarchy.",
    source: { path: "design-systems/perplexity" },
  },
  {
    id: "od:design-system:perspective",
    kind: "design-system",
    name: "Perspective",
    description:
      "Spatial depth design with isometric views, vanishing points, and layered elements that guide attention through 3D-like realism.",
    source: { path: "design-systems/perspective" },
  },
  {
    id: "od:design-system:pinterest",
    kind: "design-system",
    name: "Pinterest",
    description: "Visual discovery. Red accent, masonry grid, image-first.",
    source: { path: "design-systems/pinterest" },
  },
  {
    id: "od:design-system:playstation",
    kind: "design-system",
    name: "Playstation",
    description:
      "Gaming console retail. Three-surface channel layout, quiet-authority display type, cyan hover-scale.",
    source: { path: "design-systems/playstation" },
  },
  {
    id: "od:design-system:posthog",
    kind: "design-system",
    name: "Posthog",
    description:
      "Product analytics. Playful hedgehog branding, developer-friendly dark UI.",
    source: { path: "design-systems/posthog" },
  },
  {
    id: "od:design-system:premium",
    kind: "design-system",
    name: "Premium",
    description:
      "Apple-inspired premium aesthetic with precise spacing, modern typography, and a refined, polished visual language.",
    source: { path: "design-systems/premium" },
  },
  {
    id: "od:design-system:professional",
    kind: "design-system",
    name: "Professional",
    description:
      "Polished, business-ready design with modern typography, structured layouts, and a trustworthy visual identity.",
    source: { path: "design-systems/professional" },
  },
  {
    id: "od:design-system:publication",
    kind: "design-system",
    name: "Publication",
    description:
      "Print-inspired visual language for books, magazines, and reports with editorial grids and expressive typography.",
    source: { path: "design-systems/publication" },
  },
  {
    id: "od:design-system:raycast",
    kind: "design-system",
    name: "Raycast",
    description:
      "Productivity launcher. Sleek dark chrome, vibrant gradient accents.",
    source: { path: "design-systems/raycast" },
  },
  {
    id: "od:design-system:refined",
    kind: "design-system",
    name: "Refined",
    description:
      "Carefully curated, modern minimal style with elegant serif typography and understated, sophisticated palettes.",
    source: { path: "design-systems/refined" },
  },
  {
    id: "od:design-system:renault",
    kind: "design-system",
    name: "Renault",
    description:
      "French automotive. Vibrant aurora gradients, NouvelR typography, bold energy.",
    source: { path: "design-systems/renault" },
  },
  {
    id: "od:design-system:replicate",
    kind: "design-system",
    name: "Replicate",
    description: "Run ML models via API. Clean white canvas, code-forward.",
    source: { path: "design-systems/replicate" },
  },
  {
    id: "od:design-system:resend",
    kind: "design-system",
    name: "Resend",
    description: "Email API. Minimal dark theme, monospace accents.",
    source: { path: "design-systems/resend" },
  },
  {
    id: "od:design-system:retro",
    kind: "design-system",
    name: "Retro",
    description:
      "Throwback design with vintage-inspired typography, high-contrast retro palettes, and nostalgic visual elements.",
    source: { path: "design-systems/retro" },
  },
  {
    id: "od:design-system:revolut",
    kind: "design-system",
    name: "Revolut",
    description:
      "Digital banking. Sleek dark interface, gradient cards, fintech precision.",
    source: { path: "design-systems/revolut" },
  },
  {
    id: "od:design-system:runwayml",
    kind: "design-system",
    name: "Runwayml",
    description: "AI video generation. Cinematic dark UI, media-rich layout.",
    source: { path: "design-systems/runwayml" },
  },
  {
    id: "od:design-system:sanity",
    kind: "design-system",
    name: "Sanity",
    description: "Headless CMS. Red accent, content-first editorial layout.",
    source: { path: "design-systems/sanity" },
  },
  {
    id: "od:design-system:sentry",
    kind: "design-system",
    name: "Sentry",
    description:
      "Error monitoring. Dark dashboard, data-dense, pink-purple accent.",
    source: { path: "design-systems/sentry" },
  },
  {
    id: "od:design-system:shadcn",
    kind: "design-system",
    name: "Shadcn",
    description:
      "Shadcn/ui-inspired design with minimal, clean components, monochrome palette, and utility-first patterns.",
    source: { path: "design-systems/shadcn" },
  },
  {
    id: "od:design-system:shopify",
    kind: "design-system",
    name: "Shopify",
    description:
      "E-commerce platform. Dark-first cinematic, neon green accent, ultra-light type.",
    source: { path: "design-systems/shopify" },
  },
  {
    id: "od:design-system:simple",
    kind: "design-system",
    name: "Simple",
    description:
      "Straightforward, no-frills design with clean typography, neutral colors, and intuitive layouts that stay out of the way.",
    source: { path: "design-systems/simple" },
  },
  {
    id: "od:design-system:skeumorphism",
    kind: "design-system",
    name: "Skeumorphism",
    description:
      "Real-world mimicry with textured surfaces, 3D effects, and familiar physical metaphors for intuitive digital interfaces.",
    source: { path: "design-systems/skeumorphism" },
  },
  {
    id: "od:design-system:slack",
    kind: "design-system",
    name: "Slack",
    description:
      "Workplace communication platform. Aubergine-primary, multi-accent logo palette, light surfaces with dark sidebar, warm and approachable.",
    source: { path: "design-systems/slack" },
  },
  {
    id: "od:design-system:sleek",
    kind: "design-system",
    name: "Sleek",
    description:
      "Modern minimalist aesthetic with clean lines, intentional color palette, subtle interactions, and consistent spacing.",
    source: { path: "design-systems/sleek" },
  },
  {
    id: "od:design-system:spacex",
    kind: "design-system",
    name: "Spacex",
    description:
      "Space technology. Stark black and white, full-bleed imagery, futuristic.",
    source: { path: "design-systems/spacex" },
  },
  {
    id: "od:design-system:spacious",
    kind: "design-system",
    name: "Spacious",
    description:
      "Generous whitespace, consistent padding, and grid-based layouts for clean, readable, and breathing interfaces.",
    source: { path: "design-systems/spacious" },
  },
  {
    id: "od:design-system:spotify",
    kind: "design-system",
    name: "Spotify",
    description:
      "Music streaming. Vibrant green on dark, bold type, album-art-driven.",
    source: { path: "design-systems/spotify" },
  },
  {
    id: "od:design-system:starbucks",
    kind: "design-system",
    name: "Starbucks",
    description:
      "Global coffee retail brand. Four-tier green system, warm cream canvas, full-pill buttons.",
    source: { path: "design-systems/starbucks" },
  },
  {
    id: "od:design-system:storytelling",
    kind: "design-system",
    name: "Storytelling",
    description:
      "Narrative-driven design using visuals, copy, and interaction to guide users through engaging, emotionally resonant journeys.",
    source: { path: "design-systems/storytelling" },
  },
  {
    id: "od:design-system:stripe",
    kind: "design-system",
    name: "Stripe",
    description:
      "Payment infrastructure. Signature purple gradients, weight-300 elegance.",
    source: { path: "design-systems/stripe" },
  },
  {
    id: "od:design-system:supabase",
    kind: "design-system",
    name: "Supabase",
    description:
      "Open-source Firebase alternative. Dark emerald theme, code-first.",
    source: { path: "design-systems/supabase" },
  },
  {
    id: "od:design-system:superhuman",
    kind: "design-system",
    name: "Superhuman",
    description:
      "Fast email client. Premium dark UI, keyboard-first, purple glow.",
    source: { path: "design-systems/superhuman" },
  },
  {
    id: "od:design-system:tesla",
    kind: "design-system",
    name: "Tesla",
    description:
      "Electric automotive. Radical subtraction, full-viewport photography, near-zero UI.",
    source: { path: "design-systems/tesla" },
  },
  {
    id: "od:design-system:tetris",
    kind: "design-system",
    name: "Tetris",
    description:
      "Classic block-game inspired design with playful colors, bold display fonts, and compact, high-energy layouts.",
    source: { path: "design-systems/tetris" },
  },
  {
    id: "od:design-system:theverge",
    kind: "design-system",
    name: "Theverge",
    description:
      "Tech editorial media. Acid-mint and ultraviolet accents, Manuka display, rave-flyer story tiles.",
    source: { path: "design-systems/theverge" },
  },
  {
    id: "od:design-system:together-ai",
    kind: "design-system",
    name: "Together AI",
    description:
      "Open-source AI infrastructure. Technical, blueprint-style design.",
    source: { path: "design-systems/together-ai" },
  },
  {
    id: "od:design-system:totality-festival",
    kind: "design-system",
    name: "Totality Festival",
    description:
      'A cosmic-premium, glassmorphic dark system that captures the visceral awe of a solar eclipse — obsidian surfaces, amber "corona" highlights, and cyan atmospheric accents.',
    source: { path: "design-systems/totality-festival" },
  },
  {
    id: "od:design-system:uber",
    kind: "design-system",
    name: "Uber",
    description:
      "Mobility platform. Bold black and white, tight type, urban energy.",
    source: { path: "design-systems/uber" },
  },
  {
    id: "od:design-system:urdu",
    kind: "design-system",
    name: "Urdu",
    description:
      "Urdu-first digital experiences with native RTL support,Nastaliq typography, and bilingual harmony.",
    source: { path: "design-systems/urdu" },
  },
  {
    id: "od:design-system:vercel",
    kind: "design-system",
    name: "Vercel",
    description: "Frontend deployment. Black and white precision, Geist font.",
    source: { path: "design-systems/vercel" },
  },
  {
    id: "od:design-system:vibrant",
    kind: "design-system",
    name: "Vibrant",
    description:
      "Lively, colorful design with bold playful typography, warm accents, and dynamic visual energy.",
    source: { path: "design-systems/vibrant" },
  },
  {
    id: "od:design-system:vintage",
    kind: "design-system",
    name: "Vintage",
    description:
      "1950s-1990s nostalgia with skeuomorphic touches, grainy textures, retro color palettes, and pixel-style typography.",
    source: { path: "design-systems/vintage" },
  },
  {
    id: "od:design-system:vodafone",
    kind: "design-system",
    name: "Vodafone",
    description:
      "Global telecom brand. Monumental uppercase display, Vodafone Red chapter bands.",
    source: { path: "design-systems/vodafone" },
  },
  {
    id: "od:design-system:voltagent",
    kind: "design-system",
    name: "Voltagent",
    description:
      "AI agent framework. Void-black canvas, emerald accent, terminal-native.",
    source: { path: "design-systems/voltagent" },
  },
  {
    id: "od:design-system:warp",
    kind: "design-system",
    name: "Warp",
    description:
      "Modern terminal. Dark IDE-like interface, block-based command UI.",
    source: { path: "design-systems/warp" },
  },
  {
    id: "od:design-system:webex",
    kind: "design-system",
    name: "Webex",
    description:
      "Collaboration platform. Momentum typography, blue action system, multi-user accent spectrum.",
    source: { path: "design-systems/webex" },
  },
  {
    id: "od:design-system:webflow",
    kind: "design-system",
    name: "Webflow",
    description:
      "Visual web builder. Blue-accented, polished marketing site aesthetic.",
    source: { path: "design-systems/webflow" },
  },
  {
    id: "od:design-system:wechat",
    kind: "design-system",
    name: "Wechat",
    description:
      "Brand visual language for WeChat Mini Programs, official accounts, and open ecosystem extensions.",
    source: { path: "design-systems/wechat" },
  },
  {
    id: "od:design-system:wired",
    kind: "design-system",
    name: "Wired",
    description:
      "Tech magazine. Paper-white broadsheet density, custom serif display, mono kickers, ink-blue links.",
    source: { path: "design-systems/wired" },
  },
  {
    id: "od:design-system:wise",
    kind: "design-system",
    name: "Wise",
    description: "Money transfer. Bright green accent, friendly and clear.",
    source: { path: "design-systems/wise" },
  },
  {
    id: "od:design-system:x-ai",
    kind: "design-system",
    name: "X AI",
    description: "Elon Musk's AI lab. Stark monochrome, futuristic minimalism.",
    source: { path: "design-systems/x-ai" },
  },
  {
    id: "od:design-system:xiaohongshu",
    kind: "design-system",
    name: "Xiaohongshu",
    description:
      "Lifestyle UGC social platform. Singular brand red, generous radius, content-first.",
    source: { path: "design-systems/xiaohongshu" },
  },
  {
    id: "od:design-system:zapier",
    kind: "design-system",
    name: "Zapier",
    description:
      "Automation platform. Warm orange, friendly illustration-driven.",
    source: { path: "design-systems/zapier" },
  },
  {
    id: "vm0:image-style:notion-illustration",
    kind: "image-style",
    name: "Notion Illustration",
    description:
      "Zero-native illustration style for hand-drawn product spot illustrations with simple ink contours and soft backgrounds.",
    desc: 'Notion-editorial-style hand-drawn spot illustration. Black brush-pen ink on white, tapered confident strokes, solid-black curly hair, solid-black pants/shoes, 3/4 face turned toward viewer with closed-eye smile and soft nose hint, open breathing body outlines, and 1-3 supporting scene props + ambient marks that frame the moment. Trigger when user says /notion-illustration, asks for a "Notion-style illustration", "Notion spot illustration", or a new piece in this hand-drawn brush-pen Notion editorial style.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/notion-illustration",
    },
  },
  {
    id: "vm0:image-style:vm0-illustration",
    kind: "image-style",
    name: "vm0 Illustration",
    description:
      "vm0 in-app spot illustration style with bold hand-drawn ink line art, white-filled interiors, and a soft rounded color backdrop.",
    desc: "Generate vm0-style vm0 in-app spot illustrations: bold hand-drawn ink line art with white-filled interiors, a soft rounded color backdrop, transparent output, and simple iconic metaphors for product states.",
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/vm0-illustration",
    },
  },
  {
    id: "vm0:image-style:postcard-illustration",
    kind: "image-style",
    name: "Postcard Illustration",
    description:
      "Hand-drawn editorial postcard / travel-journal illustration with fine black ink linework, flat saturated gouache fills, sharp edges, dense small repeated ink patterns, paper-grain texture, sparse white speckles, and a tall portrait composition.",
    desc: 'Hand-drawn editorial postcard illustration style. Fine black marker/pen ink linework over flat saturated gouache color fills with sharp edges, dense small repeated ink patterns on surfaces (rows of windows, shingle curves, hatching, stippling), subtle paper-grain background texture, tiny scattered white speckles (snow / petals / sparkle), and a tall portrait composition with a layered foreground-midground-background. Travel-journal / urban-sketcher aesthetic. Trigger when the user says /postcard-illustration, asks for a "postcard illustration", "travel illustration", "urban sketcher style", or briefs a palette + scene archetype + complexity.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/postcard-illustration",
    },
  },
  {
    id: "vm0:image-style:folk-storybook",
    kind: "image-style",
    name: "Folk Storybook Illustration",
    description:
      "Folk-art children's picture-book illustration — hand-painted gouache and watercolor scenes with anthropomorphic animal characters, closed-crescent-eye smiles, dusty muted folk palette, and decorative pattern surfaces.",
    desc: "Folk-art children's picture-book illustration style — hand-painted gouache/watercolor scene on aged paper, anthropomorphic animal characters with closed-crescent-eye smiles, dusty muted folk palette, decorative pattern surfaces (wallpaper, rugs, textiles), and a hushed lullaby mood. Trigger when users ask for a folk-art illustration, storybook scene, cozy animal illustration, or any new piece in this Eastern European picture-book style.",
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/folk-storybook",
    },
  },
  {
    id: "vm0:image-style:papernook",
    kind: "image-style",
    name: "Papernook",
    description:
      "Hand-drawn editorial illustration set in a cozy cluttered personal-studio scene with warm cream paper, scratchy ink, painterly gouache fills, dot-eye character face, and dense edge-to-edge thematic props.",
    desc: 'Hand-drawn editorial illustration in the spirit of a cluttered personal-studio scene. Loose scratchy black ink outlines that wobble, textured gouache fills with visible brush marks, warm cream paper background, simplified dot-eye character face, and a DENSE edge-to-edge composition where a centered character is orbited by thematic props that visually act out the scene metaphor. Default palette: dusty cornflower blue, soft coral pink, fresh sage green, charcoal, warm cream — no mustard, no burnt-orange. Trigger when user says /papernook, asks for a "papernook illustration", a "cozy cluttered editorial scene", a "warm-cream desk scene", or a new piece in this hand-drawn studio-clutter editorial style.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/papernook",
    },
  },
  {
    id: "vm0:image-style:painterly-botanical",
    kind: "image-style",
    name: "Painterly Botanical",
    description:
      "Painterly watercolor + gouache portrait illustration with a single figure embraced by lush botanicals, closed-eye introspective expression, and a softly tinted paper-wash background.",
    desc: 'Painterly watercolor + gouache portrait illustration. Single figure (closed eyes, contemplative) embraced by botanicals — leaves, blossoms, grasses. Translucent washes with visible pigment bleeds, sparse crisp ink line accents on key edges, tiny handwritten cursive signature in an upper corner, and a tinted paper-wash background (never pure white). Eight user axes drive composition: subject, hair, pose, botanicals, palette, background wash, complexity (L1/L2/L3), and format. Trigger when a brief describes a contemplative figure with foliage, a "watercolor portrait", a "botanical embrace", or asks for a piece in this painterly editorial style.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/painterly-botanical",
    },
  },
  {
    id: "vm0:image-style:iso-scene",
    kind: "image-style",
    name: "Isometric Editorial Scene",
    description:
      "Isometric editorial-magazine scene illustration with ultra-fine hairline outlines, flat fills, a saturated monochromatic background, and a scene-as-metaphor composition built from theme-native props.",
    desc: 'Isometric editorial-magazine scene illustration in a locked flat-vector style — ultra-fine hairline outlines, monochromatic saturated background filling the canvas, and a single composed scene whose props themselves embody the theme. Trigger when users say /iso-scene, ask for an "isometric editorial illustration", a "scene illustration in the editorial machine style", or brief with palette + scene archetype + complexity.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/iso-scene",
    },
  },
  {
    id: "vm0:image-style:inkdab",
    kind: "image-style",
    name: "Inkdab Illustration",
    description:
      "Brush-pen editorial illustration where a free-floating color dab is painted first, then loose black ink linework is drawn freely on top — never as an outline around the color. Scribbled hatched hair, open-outline bodies, pure white background.",
    desc: 'Brush-pen editorial illustration style — a flat accent-color "dab" painted first, then loose black ink drawn freely on top. ONE flat accent-color shape per prop (painted-first, never outlined in black), black hand-wobbled ink on pure white background, scribbled hatched hair, open-outline bodies with zero fill, and one small solid-accent triangle floating freely as a recurring motif. Trigger when user says /inkdab, asks for an "inkdab illustration", a "brush-pen illustration with a single accent color", a "free-floating color block illustration", or briefs in the style of the included reference images.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/inkdab",
    },
  },
  {
    id: "vm0:image-style:riso-relic",
    kind: "image-style",
    name: "Riso Relic",
    description:
      'Pop-art retro risograph poster of a single nostalgic everyday object on a saturated single-hue field — bold black ink outlines, halftone grain, hand-drawn doodle accents, tiny "SMALL OBJECTS IN TIME" banner up top, chunky retro headline with offset drop-shadow at the bottom.',
    desc: 'Pop-art retro risograph poster of a single nostalgic everyday object — saturated single-color background, bold black ink outlines, halftone/riso grain, hand-drawn doodle accents (sparkles, squiggles, dots, music notes, lightning), tiny white "SMALL OBJECTS IN TIME" banner at top, chunky retro display headline at bottom with offset black drop-shadow. Trigger when user says /riso-relic, asks for a "riso poster", a "small objects in time" illustration, or any new piece in this nostalgic pop-art relic-object style.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/riso-relic",
    },
  },
  {
    id: "vm0:image-style:inkstomp",
    kind: "image-style",
    name: "Inkstomp",
    description:
      "Loud indie-packaging poster style — full-bleed saturated flat color, a two-line hand-lettered headline, and one weird-cute black brush-ink character.",
    desc: 'Inkstomp — a loud, hand-screened indie-packaging poster style. Full-bleed saturated flat color filling the entire canvas, a two-line hand-lettered headline (thin arched caps over chunky drop-shadowed display), and one weird-cute character drawn in thick uniform black brush ink. Trigger when the user says /inkstomp, asks for an "inkstomp poster", a "Ray Fenwick / Hattie Stewart packaging poster", an "indie brush-ink flavor card", or briefs in a "palette + headline + character" shape.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/inkstomp",
    },
  },
  {
    id: "vm0:image-style:folk-muse",
    kind: "image-style",
    name: "Folk Muse",
    description:
      "Flat folk-art gouache portrait style — a single contemplative chest-up figure framed by an asymmetric botanical surround, with painted irises, smooth flat hair, a hand against the cheek, and a patterned robe.",
    desc: 'Flat folk-art gouache portrait illustration in the contemporary editorial style of Carson Ellis, Maja Tomljanovic, and Bodil Jane. A single chest-up figure with an elongated mannerist oval face, tiny almond half-lidded eyes, smooth flat hair, one hand pressed against the face, a patterned robe filling the lower frame, and an asymmetric botanical surround filling the background edge-to-edge. Hand-painted matte gouache texture, flat color blocks, no harsh outlines, no photorealism. Calm, slightly melancholic, contemplative mood. Trigger when the user says /folk-muse, asks for a "folk-art portrait", "gouache portrait", "Carson Ellis style portrait", or any new piece in this contemplative folk-portrait style.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/folk-muse",
    },
  },
  {
    id: "vm0:image-style:sunlit-gouache",
    kind: "image-style",
    name: "Sunlit Gouache",
    description:
      "Bright pastel travel-painting illustration in opaque gouache on textured paper with chunky flat brushstrokes, vertical one-point perspective, and figures walking into warm sunlight.",
    desc: 'Sunlit Gouache travel-painting illustration. Opaque gouache on textured paper, visible chunky flat brushstrokes with dry-brush highlights, locked six-color palette (cream, butter-yellow, sky-blue, sage-green, terracotta, one small red accent), vertical 2:3 one-point-perspective composition drawing the eye into a bright sunlit focal point, figures seen from behind walking into the scene, an overhead band of hanging elements (awning, prayer flags, catenary, bunting, lanterns) creating depth, dappled painterly reflections on the ground, airy optimistic warm mood. Trigger when user says /sunlit-gouache, asks for a "sunlit gouache illustration", "painterly travel scene", "gouache café/market/temple/station scene", or a new piece in this bright pastel painted-light style.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/sunlit-gouache",
    },
  },
  {
    id: "vm0:image-style:mosaic-still-life",
    kind: "image-style",
    name: "Mosaic Still Life",
    description:
      "Editorial still-life illustration in a mosaic-tile + painterly hybrid style — tessellated ground/sky/wall surfaces with crisp painterly objects, an animal companion, and a patterned textile peeking through.",
    desc: 'Mosaic-tile + painterly hybrid editorial illustration. Tessellated/pointillist mosaic surfaces (grass, sky, sand, walls, floors) anchor the scene, with crisp painterly still-life objects rendered ON TOP. Always features a still-life centerpiece on a table, an animal companion at the heart of the scene, and at least one patterned textile peeking through. Cozy, nostalgic, bucolic mood. Trigger when user says /mosaic-still-life, asks for a "mosaic illustration", "mosaic-tile editorial illustration", "tessellated still life", or briefs with a palette + scene + animal in this style.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/mosaic-still-life",
    },
  },
  {
    id: "vm0:image-style:ink-mascot",
    kind: "image-style",
    name: "Ink Mascot",
    description:
      "Vintage editorial marketing card. Bold serif headline and short serif descriptor over a hand-drawn black-ink anthropomorphic mascot (stick limbs, chunky white sneakers) on a single solid saturated flat color background.",
    desc: 'Generate a 3:5 portrait editorial marketing card in a locked vintage-textbook style. Bold serif headline plus an optional short serif descriptor sit on a single solid saturated flat color background (no gradient, no divider, no ground line). A hand-drawn black-ink anthropomorphic hero object — paint bucket, magnifying glass, envelope, notebook, funnel, megaphone, rocket, seedling, gift box, compass, etc. — stands with two thin stick arms, two stick legs, and chunky white sneakers with black laces (the signature detail). Crosshatch and stipple shading on rounded surfaces; floating ink doodles (sparkles, arrows, hearts, percent or dollar signs, motion lines) at the requested density. Dialable along six axes: concept, palette, hero object, action, doodle density (L1 minimal, L2 balanced, L3 packed), and type layout (A title-top, B headline-bottom, C headline-only, D big-word + tiny-descriptor). Trigger when user says /ink-mascot, asks for a "marketing card illustration", a "retro editorial mascot poster", or briefs with a marketing concept plus palette plus character.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/ink-mascot",
    },
  },
  {
    id: "vm0:image-style:sticker-sheet",
    kind: "image-style",
    name: "Sticker Sheet",
    description:
      "Hand-painted gouache sticker-sheet illustration with ~20 themed objects floating on white, punchy saturated palette, wobbly hand-drawn ink overlay, and tiny decorative marks on every item.",
    desc: 'Sticker Sheet — hand-painted gouache sticker-sheet illustration. ~20 small floating themed objects on pure white, punchy saturated palette (coral, mustard, sage, dusty pink, navy, cream, warm brown), flat brushy gouache fills with wobbly hand-drawn ink linework and tiny decorative marks (dots, hatches, squiggles) on every object. Each object slightly tilted, no drop shadows, cheerful cozy lifestyle journal mood. Trigger when user says /sticker-sheet, asks for a "sticker sheet illustration", "hand-painted gouache sticker pack", "themed object sheet", or briefs with a scene theme + object count in this house style.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/sticker-sheet",
    },
  },
  {
    id: "vm0:image-style:flat-poster",
    kind: "image-style",
    name: "Flat Poster",
    description:
      "Vertical flat-color editorial poster style — saturated solid background, one centered hand-drawn vector subject in bold deep-navy outlines with strict two-tone fill, headline pinned top-left, wordmark pinned bottom-right.",
    desc: 'Flat Poster — a vertical flat-color editorial poster style for brand benefit cards, marketing posters, and in-app campaign visuals. Portrait 2:3 canvas filled edge-to-edge with one saturated hue; a single centered hand-drawn vector subject in deep-navy outlines with strict two-tone fill (pure white plus one darker bg-tint accent); a bold rounded sans-serif headline pinned top-left; a short wordmark (default VM0) pinned bottom-right; small floating accent marks around the subject; no body copy. Six creative dials: palette, subject archetype, composition preset, accent marks, headline voice, mood. Trigger when the user says /flat-poster, asks for a "flat-color editorial poster", a "brand benefit card", a "marketing card in the bold outline + flat color style", or briefs with a palette + subject + headline shape.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/flat-poster",
    },
  },
  {
    id: "vm0:image-style:mellow-pop",
    kind: "image-style",
    name: "Mellow Pop",
    description:
      "Chill flat-vector editorial poster of a serene recurring character on a fully saturated solid color background, with a signature pop of bright leaf-green and a scene-as-metaphor composition.",
    desc: 'Mellow-pop flat-vector editorial illustration: a recurring chill character with closed-eye smile, tiny nose hint, and short dark bobbed hair, posed inside a scene-as-metaphor composition on a single fully saturated solid color background, with a signature pop of bright leaf-green woven into every piece (hero prop, plants, motifs, or sweater). Thin uniform black outlines, flat solid fills only, no gradients or texture. Five dials per brief: palette, scene metaphor, complexity (L1/L2/L3), pose, outfit accent. Trigger when user says /mellow-pop, asks for a "mellow-pop illustration", "chill flat-vector poster", or briefs with a scene metaphor + palette + complexity.',
    source: {
      repo: VM0_SKILLS_REPO,
      ref: VM0_SKILLS_REF,
      path: "illustration-template/mellow-pop",
    },
  },
];

function filterByKind(
  kind: OpenDesignResourceKind,
): readonly OpenDesignRegistryEntry[] {
  return OPEN_DESIGN_REGISTRY.filter((entry) => {
    return entry.kind === kind;
  });
}

export function listImageStyles(): readonly OpenDesignRegistryEntry[] {
  return filterByKind("image-style");
}

export function findImageStyle(
  id: string,
): OpenDesignRegistryEntry | undefined {
  return listImageStyles().find((entry) => {
    return entry.id === id;
  });
}

export function toOpenDesignTarget(value: string): OpenDesignTarget {
  if (value === "dashboard") {
    return "dashboard-design";
  }

  if (value === "docs") {
    return "docs-design";
  }

  if (value === "mobile-app") {
    return "mobile-app-design";
  }

  return value as OpenDesignTarget;
}

export function selectOpenDesignCandidates(): OpenDesignCandidateSlice {
  return {
    registryVersion: OPEN_DESIGN_REGISTRY_VERSION,
    source: {
      repo: OPEN_DESIGN_REPO,
      ref: OPEN_DESIGN_COMMIT,
    },
    sources: [
      {
        repo: OPEN_DESIGN_REPO,
        ref: OPEN_DESIGN_COMMIT,
      },
      {
        repo: VM0_SKILLS_REPO,
        ref: VM0_SKILLS_REF,
      },
    ],
    candidates: {
      skills: filterByKind("skill"),
      templates: filterByKind("template"),
      designSystems: filterByKind("design-system"),
      imageStyles: filterByKind("image-style"),
      audioStyles: filterByKind("audio-style"),
      videoTemplates: filterByKind("video-template"),
      bundleTemplates: filterByKind("bundle-template"),
    },
  };
}
