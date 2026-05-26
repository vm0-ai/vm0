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
type OpenDesignResourceStatus = "curated" | "experimental";
type OpenDesignExecutorHint =
  | "agent-authored-html"
  | "built-in-image"
  | "built-in-video"
  | "built-in-voice"
  | "connector-backed"
  | "skill-authored";
type OpenDesignPreviewHint =
  | "hosted-url"
  | "image"
  | "video"
  | "audio"
  | "mixed-directory"
  | "file";
type OpenDesignRemixHint =
  | "prompt"
  | "prompt-with-resource-hints"
  | "source-assets";

interface OpenDesignSourceRef {
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
}

export interface OpenDesignRegistryEntry {
  readonly id: string;
  readonly kind: OpenDesignResourceKind;
  readonly name: string;
  readonly description: string;
  readonly desc?: string;
  readonly source: OpenDesignSourceRef;
  readonly targets: readonly OpenDesignTarget[];
  readonly tags: readonly string[];
  readonly triggers?: readonly string[];
  readonly bestFor?: readonly string[];
  readonly avoidFor?: readonly string[];
  readonly compatibleWith?: readonly string[];
  readonly outputKinds?: readonly GenerationOutputKind[];
  readonly primaryOutputKind?: GenerationOutputKind;
  readonly supportingOutputKinds?: readonly GenerationOutputKind[];
  readonly executorHints?: readonly OpenDesignExecutorHint[];
  readonly previewHint?: OpenDesignPreviewHint;
  readonly remixHint?: OpenDesignRemixHint;
  readonly status: OpenDesignResourceStatus;
  readonly priority?: number;
}

export interface OpenDesignCandidateSlice {
  readonly registryVersion: string;
  readonly source: {
    readonly repo: string;
    readonly commit: string;
  };
  readonly sources: readonly {
    readonly repo: string;
    readonly commit: string;
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

const OPEN_DESIGN_REPO = "vm0-ai/open-design";
const OPEN_DESIGN_COMMIT = "d021b04720ace133f1d6133d1487326f5fc28f07";
const VM0_SKILLS_REPO = "vm0-ai/vm0-skills";
const VM0_SKILLS_REF = "main";

const OPEN_DESIGN_REGISTRY_VERSION = `federated:${OPEN_DESIGN_REPO}@${OPEN_DESIGN_COMMIT}`;

function sourceRef(
  repo: string,
  commit: string,
  path: string,
): OpenDesignSourceRef {
  return {
    repo,
    commit,
    path,
  };
}

function source(path: string): OpenDesignSourceRef {
  return sourceRef(OPEN_DESIGN_REPO, OPEN_DESIGN_COMMIT, path);
}

const STYLE_OPEN_DESIGN_SKILL_SLUGS = [
  "8-bit-orbit-video-template",
  "after-hours-editorial-template",
  "algorithmic-art",
  "apple-hig",
  "brainstorming",
  "brand-guidelines",
  "canvas-design",
  "card-twitter",
  "card-xiaohongshu",
  "color-expert",
  "creative-director",
  "d3-visualization",
  "deck-guizang-editorial",
  "deck-open-slide-canvas",
  "deck-swiss-international",
  "design-consultation",
  "design-md",
  "design-review",
  "digits-fintech-swiss-template",
  "doc-kami-parchment",
  "editorial-burgundy-principles-template",
  "enhance-prompt",
  "faq-page",
  "field-notes-editorial-template",
  "figma-create-design-system-rules",
  "figma-generate-design",
  "figma-generate-library",
  "figma-implement-design",
  "flutter-animating-apps",
  "frame-data-chart-nyt",
  "frame-flowchart-sticky",
  "frame-glitch-title",
  "frame-light-leak-cinema",
  "frame-liquid-bg-hero",
  "frame-logo-outro",
  "frame-macos-notification",
  "frontend-design",
  "frontend-dev",
  "frontend-skill",
  "frontend-slides",
  "gsap-core",
  "gsap-react",
  "gsap-scrolltrigger",
  "gsap-timeline",
  "hand-drawn-diagrams",
  "hatch-pet",
  "html-ppt-retro-quarterly-review",
  "login-flow",
  "mockup-device-3d",
  "paywall-upgrade-cro",
  "plan-design-review",
  "platform-design",
  "poster-hero",
  "ppt-keynote",
  "release-notes-one-pager",
  "resume-modern",
  "screenshots-marketing",
  "shadcn-ui",
  "shader-dev",
  "slack-gif-creator",
  "slides",
  "social-reddit-card",
  "social-spotify-card",
  "social-x-post-card",
  "stitch-loop",
  "swiftui-design",
  "swiss-creative-mode-template",
  "swiss-user-research-video-template",
  "taste-skill",
  "theme-factory",
  "threejs",
  "ui-skills",
  "ui-ux-pro-max",
  "vfx-text-cursor",
  "video-hyperframes",
  "web-design-guidelines",
  "weread-year-in-review-video-template",
  "wpds",
] as const;

const STYLE_OPEN_DESIGN_SKILL_DESCRIPTIONS = {
  "8-bit-orbit-video-template":
    "Hyperframes-based video template for retro pixel deck motion design. Use when users want a high-fidelity, multi-scene HTML-to-video composition with advanced transitions, interactive preview controls, and ready-to-render default style.",
  "after-hours-editorial-template":
    "Luxury dark-editorial HyperFrames template for three-page cinematic storyboards, inspired by haute couture title cards and magazine chapter spreads. Use when the user asks for premium fashion-style motion pages, moody serif-led storytelling, or a high-end dark presentation aesthetic with rich transitions.",
  "algorithmic-art":
    "Create generative art using p5.js with seeded randomness so every render is reproducible. Useful for procedural posters, motion-style stills, and artistic frame studies.",
  "apple-hig":
    "Apple Human Interface Guidelines as 14 agent skills covering platforms, foundations, components, patterns, inputs, and technologies for iOS, macOS, visionOS, watchOS, and tvOS.",
  brainstorming:
    "Transform rough ideas into fully-formed designs through structured questioning and alternative exploration. Useful early in concept work.",
  "brand-guidelines":
    "Apply Anthropic's official brand colors and typography to artifacts for consistent visual identity and professional design standards. A reference for shaping your own.",
  "canvas-design":
    "Create beautiful visual art in PNG and PDF documents using design philosophy and aesthetic principles for posters, illustrations, and static pieces.",
  "card-twitter": "Twitter quote or data card designed to pair with a post.",
  "card-xiaohongshu":
    "Xiaohongshu-style knowledge cards, arranged as a swipeable multi-card carousel.",
  "color-expert":
    "Color science expert skill with 286K words of reference material covering OKLCH/OKLAB, palette generation, accessibility/contrast, color naming, pigment mixing, and historical color theory.",
  "creative-director":
    "AI creative director with recursive self-assessment: 20+ methodologies (SIT, TRIZ, Bisociation, SCAMPER, Synectics), 3-axis evaluation calibrated against Cannes/D&AD/HumanKind, 5-phase process from brief to presentation.",
  "d3-visualization":
    "Teaches the agent to produce D3 charts and interactive data visualizations. Useful for editorial dashboards, reports, and explanatory graphics.",
  "deck-guizang-editorial":
    "Editorial magazine meets e-ink: 10 layouts and 5 palettes (Ink, Indigo Porcelain, Forest Ink, Kraft Paper, Dune).",
  "deck-open-slide-canvas":
    "Locked 1920x1080 canvas deck with React component-level free composition, not bound to a fixed template.",
  "deck-swiss-international":
    "16-column grid, one saturated accent, and 22 locked layouts (Klein Blue, Lemon, Mint, Safety Orange).",
  "design-consultation":
    "Build a complete design system from scratch with creative risks and realistic product mockups. Useful for kickoff workshops and brand-from-zero work.",
  "design-md":
    "Create and manage DESIGN.md files. Useful for capturing design direction, tokens, and visual rules in a single source of truth.",
  "design-review":
    "Designer Who Codes: visual audit then fixes with atomic commits and before/after screenshots. Useful for tightening shipped UI before launch.",
  "digits-fintech-swiss-template":
    "Swiss-grid fintech deck template in black / warm paper / neon-lime contrast. Use when users ask for premium data-story slides with strict modular layout, bold numeric cards, restrained motion, and keyboard/click navigation in one HTML file.",
  "doc-kami-parchment":
    "Warm parchment canvas (#f5f4ed), monochrome ink-blue accent (#1B365D), one serif family, and editorial-grade typography.",
  "editorial-burgundy-principles-template":
    "Editorial studio deck template in burgundy / blush / muted-gold palette. Use when users ask for premium manifesto or culture slides with pill tags, large typographic statements, principle cards, and guided keyboard/click navigation.",
  "enhance-prompt":
    "Improve prompts with design specs and UI/UX vocabulary. Useful for design-to-code workflows and clarifying requests for visual output.",
  "faq-page":
    'A Frequently Asked Questions (FAQ) page with collapsible accordion sections, search functionality, and category filtering. Use when the brief asks for "FAQ", "help center", "questions", or "support page".',
  "field-notes-editorial-template":
    'Editorial "Field Notes" report template with soft paper background, serif hero typography, rounded pastel insight cards, and a retention chart panel. Use when users ask for a premium magazine-style business report, board memo one-pager, or elegant data storytelling layout.',
  "figma-create-design-system-rules":
    "Generate project-specific design system rules for Figma-to-code workflows. Useful for capturing tokens, naming, and lint rules in one source.",
  "figma-generate-design":
    "Build or update screens in Figma from code or description using design system components. Translate app pages into Figma using design tokens.",
  "figma-generate-library":
    "Build or update a professional-grade design system library in Figma from a codebase. Useful for keeping the Figma source of truth in sync with shipped components.",
  "figma-implement-design":
    "Translate Figma designs into production-ready code with 1:1 visual fidelity. Useful for handing off Figma frames straight to a frontend agent.",
  "flutter-animating-apps":
    "Implement animated effects, transitions, and motion in Flutter apps. Useful for native iOS/Android motion design.",
  "frame-data-chart-nyt":
    "NYT-newsroom typography, staggered reveal animation, and editorial-grade charts (line, bar, or range band).",
  "frame-flowchart-sticky":
    "SVG curve connectors, sticky-note nodes, and cursor interaction with a whiteboard-brainstorm feel.",
  "frame-glitch-title":
    "Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes.",
  "frame-light-leak-cinema":
    "Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards.",
  "frame-liquid-bg-hero":
    "WebGL-style fluid displacement background with a quote overlay, suited to video intros, landing heroes, or posters.",
  "frame-logo-outro":
    "Segmented logo assembly, glow bloom, and tagline reveal for video outros or brand closing frames.",
  "frame-macos-notification":
    "Realistic macOS notification banner with app icon, title, and body, suited to video overlays or product teasers.",
  "frontend-design":
    "Frontend design and UI/UX development tools for shipping production-ready interfaces with strong typographic and layout discipline.",
  "frontend-dev":
    "Full-stack frontend with cinematic animations, AI-generated media via MiniMax API, and generative art. Useful for hero pages and showcase sites.",
  "frontend-skill":
    "Create visually strong landing pages, websites, and app UIs with restrained composition. OpenAI's production frontend playbook.",
  "frontend-slides":
    "Generate animation-rich HTML presentations with visual style previews. Useful for online keynotes, embedded talks, and interactive briefs.",
  "gsap-core":
    "Core GSAP API with gsap.to(), from(), fromTo(), easing, duration, stagger, and defaults. Production-grade web animation primitives.",
  "gsap-react":
    "GSAP React integration with useGSAP hook, refs, gsap.context(), cleanup, and SSR. Ships safe motion in React + Next.js apps.",
  "gsap-scrolltrigger":
    "GSAP ScrollTrigger for scroll-linked animations, pinning, scrub, and refresh handling. Useful for editorial sites and product pages.",
  "gsap-timeline":
    "GSAP Timelines with sequencing, position parameter, labels, nesting, and playback control. Useful for orchestrating multi-step motion sequences.",
  "hand-drawn-diagrams":
    "Generate hand-drawn Excalidraw diagrams from a prompt - animated SVG, hosted edit link, and PNG export. Works with Claude Code, Codex, Gemini CLI, and any agent supporting standard skill paths.",
  "hatch-pet":
    "Create, repair, validate, preview, and package Codex-compatible animated pet spritesheets from character art, screenshots, generated images, or visual references. Use when a user wants to hatch a Codex pet, create a custom animated pet, or build a built-in pet asset with an 8x9 atlas, transparent unused cells, row-by-row animation prompts, QA contact sheets, preview videos, and pet.json packaging. This skill composes the installed $imagegen system skill for visual generation and uses bundled scripts for deterministic spritesheet assembly.",
  "html-ppt-retro-quarterly-review":
    "Retro Quarterly Review presentation template in a bold blue + orange editorial language. Use when users ask for a high-impact quarterly review / roadmap deck with heavyweight slab headlines, clean cream paper sections, structured grids, and fast premium motion pacing (3 slides, each hold under 3s in video mode).",
  "login-flow": "Mobile login and authentication flow screens",
  "mockup-device-3d":
    "Static iPhone and MacBook 3D-style showcase with real HTML embedded on screens, glass-lens refraction, and 360-degree turntable composition.",
  "paywall-upgrade-cro":
    "Design and optimize upgrade screens, paywalls, and upsell modals. Useful for SaaS conversion design and pricing-page experiments.",
  "plan-design-review":
    "Senior Designer review: rates each design dimension 0-10, explains what a 10 looks like, and flags AI Slop signals. Useful as a gate before merging UI work.",
  "platform-design":
    "300+ design rules from Apple HIG, Material Design 3, and WCAG 2.2 for cross-platform apps. Useful when shipping a single design across iOS, Android, and the web.",
  "poster-hero":
    "Vertical poster or Moments-style share image with strong visual impact.",
  "ppt-keynote":
    "Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation.",
  "release-notes-one-pager":
    'Release notes one-page HTML with highlights, Added, Fixed, Breaking changes, Known issues, and Upgrade note. Writes explicit "None" style sections whenever the user does not provide details.',
  "resume-modern":
    "Modern minimal resume, single A4 page, ready for print or PDF export.",
  "screenshots-marketing":
    "Generate marketing screenshots with Playwright. Useful for landing-page hero shots, App Store screenshots, and changelog visuals.",
  "shadcn-ui":
    "Build UI components with shadcn/ui. Pairs with the Stitch design loop to ship structured, accessible components quickly.",
  "shader-dev":
    "GLSL shader techniques for ray marching, fluid simulation, particle systems, and procedural generation. Useful for hero visuals and motion stills.",
  "slack-gif-creator":
    "Create animated GIFs optimized for Slack with validators for size constraints and composable animation primitives.",
  slides:
    "Create and edit .pptx presentation decks with PptxGenJS. Useful for sales decks, kickoff briefs, and design-system showcases.",
  "social-reddit-card":
    "Realistic Reddit post card with vote rail and comment count, suited to video overlays or story sharing.",
  "social-spotify-card":
    "Spotify Now Playing-style card with album art, progress bar, and playback controls, suited to video overlays or personal homepages.",
  "social-x-post-card":
    "Realistic X post card with engagement metrics (likes, reposts, views), suited to video overlays or shareable image cards.",
  "stitch-loop":
    "Iterative design-to-code feedback loop. Critique adjust ship cycle for tightening visual fidelity between brief and built UI.",
  "swiftui-design":
    "SwiftUI skill - anti AI-slop rules, design direction advisor, brand asset protocol, and five-dimension review. Works with Claude Code, Cursor, Codex, and OpenCode.",
  "swiss-creative-mode-template":
    "Swiss-inspired creative-mode presentation template skill with bold editorial typography, high-contrast geometric cards, interactive slide navigation, theme switching, hotspot overlays, and palette choreography in a single-file HTML artifact. Use when users ask for a premium presentation-style landing, a Swiss/brutalist deck look, or a creative launch page with rich interactions.",
  "swiss-user-research-video-template":
    "Swiss-style user-research narrative template in warm-paper editorial aesthetics. Use when users ask for a premium research deck or story-first live artifact with minimalist typography, high-clarity layout, subtle motion, donut breakdowns, and keyboard/click navigation across slides in a single HTML file.",
  "taste-skill":
    "High-agency frontend skill that gives AI good taste with tunable design variance, motion intensity, and visual density to stop generic UI slop.",
  "theme-factory":
    "Apply professional font and color themes to artifacts including slides, docs, reports, and HTML landing pages. Ships 10 pre-set themes.",
  threejs:
    "Three.js skills for creating 3D elements and interactive experiences in the browser - scenes, materials, controls, and post-processing.",
  "ui-skills":
    "Opinionated, evolving constraints to guide agents when building interfaces. Useful for keeping output coherent across many small UI pieces.",
  "ui-ux-pro-max":
    "Catalog-only UI/UX Pro Max entry. The full upstream templates, data, and search workflow are not bundled in Open Design.",
  "vfx-text-cursor":
    "Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros.",
  "video-hyperframes":
    "Hyperframes / Remotion-compatible continuous frame animation with autoplay support.",
  "web-design-guidelines":
    "Web design guidelines and standards by the Vercel engineering team. Covers layout, typography, color, motion, and accessibility for product UI.",
  "weread-year-in-review-video-template":
    "WeRead-inspired HyperFrames video template for vertical annual reading reports, personal reading dashboards, book-note recaps, and shareable year-in-review stories. Use when users want a 9:16 HTML-to-MP4 reading report with warm paper texture, editorial Chinese typography, book-page metaphors, data highlights, and deterministic motion.",
  wpds: "WordPress Design System. Apply WordPress's official design tokens, typography, and component patterns to themes and sites.",
} satisfies Record<(typeof STYLE_OPEN_DESIGN_SKILL_SLUGS)[number], string>;

const ADDITIONAL_OPEN_DESIGN_TEMPLATE_DESCRIPTIONS = {
  "audio-jingle":
    "Audio generation skill — jingles, beds, voiceover, and sound effects. Routes music requests to Suno V5 / Udio / Lyria, speech to MiniMax TTS / FishAudio / ElevenLabs V3, and SFX to ElevenLabs SFX or AudioCraft. Output is one MP3/WAV file saved to the project folder.",
  "blog-post":
    'A long-form article / blog post — masthead, hero image placeholder, article body with figures and pull quotes, author byline, related posts. Use when the brief asks for "blog", "article", "post", "essay", or "case study".',
  "clinical-case-report":
    'Structured medical case presentation for clinical rounds, conferences, and documentation. Generates SOAP-format or narrative case reports with physiologically accurate vitals, labs, and evidence-based plans. Use when the brief mentions "case report", "case presentation", "SOAP note", "clinical case", "ward rounds", "case summary", or "patient presentation".',
  critique:
    'Run a 5-dimension expert design review on any HTML artifact in the project — Philosophy / Visual hierarchy / Detail / Functionality / Innovation, each scored 0–10. Outputs a single self-contained HTML report with a radar chart, evidence-backed scores, and three lists: Keep / Fix / Quick-wins. Use when the brief asks for a "design review", "design critique", "5 维度评审", "design audit", or "what\'s wrong with my design".',
  "dating-web":
    'A consumer-feeling dating / matchmaking dashboard — left rail navigation, ticker bar of community signals, headline KPIs, a 30-day mutual-matches bar chart, and a match-rate trend block. Editorial typography, restrained accent. Use when the brief asks for a "dating site", "matchmaking", "community dashboard", "social network dashboard", or any consumer product where the data is the story.',
  "dcf-valuation":
    'Discounted cash flow valuation and intrinsic value analysis for public companies. Use when the brief asks for DCF, fair value, intrinsic value, price target, undervalued or overvalued analysis, or "what is this company worth?"',
  "digital-eguide":
    'A two-spread digital e-guide preview — page 1 is a cover (display title, author, "What\'s inside" stats, table of contents teaser); page 2 is a spread (lesson body with pull-quote and a step list). Lifestyle / creator brand tone. Use when the brief asks for an "e-guide", "digital guide", "lookbook", "lead magnet", "creator guide", "playbook", "PDF guide", or "电子指南".',
  "email-marketing":
    'A brand product-launch email — masthead with wordmark, hero image block, headline lockup with skewed-italic accent, body copy, primary CTA, and a specifications grid. Pure HTML email layout (centered single column, table fallback). Use when the brief asks for an "email", "newsletter blast", "MJML", "product launch email", or "email template".',
  "eng-runbook":
    'An engineering runbook — service overview, alerts table, dashboards links, common procedures with copy-pasteable commands, on-call rotation, and an incident-response checklist. Use when the brief mentions "runbook", "ops doc", "on-call guide", "SRE doc", or "运维手册".',
  "flowai-live-dashboard-template":
    "Team-management dashboard skill in the FlowAI aesthetic — three tabs (Team Members, Team Details, Activity Log), KPI stat row, member table, role distribution bar chart, online presence and activity sparklines, and a top-contributors panel, all in a single self-contained HTML file with light/dark theming, hoverable chart tooltips, click-to-zoom panels, and CSV export. Use when the brief asks for a team / workspace admin dashboard, an interactive admin dashboard with charts, or names FlowAI.",
  "gamified-app":
    'A multi-frame gamified mobile-app prototype — three phone frames on a dark showcase stage. Frame 1: cover / poster, Frame 2: today\'s quests with XP ribbons and a level bar, Frame 3: quest detail. Vivid quest tiles, level ribbon, bottom tab bar. Use when the brief asks for a "gamified app", "habit tracker", "RPG-style life app", "level-up app", "daily quests", "XP / streak app", or "ELI5-style explainer app".',
  "github-dashboard":
    "GitHub repository analytics dashboard — stars, forks, contributors, issues, pull requests, recent activity, and top contributors. Use when the brief asks for a GitHub repo dashboard, open-source growth report, repository health page, or GitHub analytics view.",
  "guizang-ppt":
    '生成"电子杂志 × 电子墨水"风格的横向翻页网页 PPT（单 HTML 文件），含 WebGL 流体背景、衬线标题 + 非衬线正文、章节幕封、数据大字报、图片网格等模板。当用户需要制作分享 / 演讲 / 发布会风格的网页 PPT，或提到"杂志风 PPT"、"horizontal swipe deck"、"editorial magazine"、"e-ink presentation"时使用。',
  "hr-onboarding":
    'A new-hire onboarding plan as a single page — first week schedule, buddy + manager intro, learning track, equipment checklist, and "you\'re set when…" outcomes. Use when the brief mentions "onboarding", "new hire", "first week plan", or "入职".',
  "html-ppt":
    'HTML PPT Studio — author professional static HTML presentations in many styles, layouts, and animations, all driven by templates. Use when the user asks for a presentation, PPT, slides, keynote, deck, slideshow, "幻灯片", "演讲稿", "做一份 PPT", "做一份 slides", a reveal-style HTML deck, a 小红书 图文, or any kind of multi-slide pitch/report/sharing document that should look tasteful and be usable with keyboard navigation. Triggers include keywords like "presentation", "ppt", "slides", "deck", "keynote", "reveal", "slideshow", "幻灯片", "演讲稿", "分享稿", "小红书图文", "talk slides", "pitch deck", "tech sharing", "technical presentation".',
  "html-ppt-course-module":
    "Online-course / workshop module deck — warm paper background + Playfair serif, persistent left sidebar of learning objectives, MCQ self-check page. Use for teaching modules, training materials, workshop slides.",
  "html-ppt-dir-key-nav-minimal":
    '8 页极简方向键 keynote — 每页一个独立单色背景（靛 / 奶 / 绛 / 翠 / 灰 / 紫 / 白 / 炭），各自配色，160px display 标题 + 4px 短粗 accent 线分隔、箭头 → 前缀的 Mono 列表、左下 ← → kbd 提示 + 右下页码、巨大呼吸留白。适合"有话要说但没什么可看"的 keynote、launch、公开演讲。',
  "html-ppt-hermes-cyber-terminal":
    "暗终端 honest-review deck — #0a0c10 黑底 + 56px 赛博网格 + CRT 暗角 + 扫描线、窗口红绿灯 chrome、`$ prompt` 命令行标题、薄荷绿 #7ed3a4 大字、JetBrains Mono、stroke-only 柱状图、blinking 光标、琥珀/绿/红三档 tag、暗色代码块。适合 CLI / agent / dev tool 测评（含 trace、diff、benchmark）。",
  "html-ppt-knowledge-arch-blueprint":
    "奶油蓝图架构 deck — 奶油纸 #F0EAE0 底色 + 单一锈红 #B5392A 高亮、48px 蓝图网格 mask、2px 黑边硬卡片、pipeline 步骤盒（其中一个抬高）、右侧锈红 insight callout、Playfair 衬线大字、SVG 虚线反馈环。零渐变零软阴影，认真且印刷友好。",
  "html-ppt-obsidian-claude-gradient":
    "GitHub 暗紫渐变 deck — GitHub-dark #0d1117 + 紫蓝 radial 环境光 + 60px 网格 mask、居中布局、紫色 pill 标签、三色渐变标题（#a855f7→#60a5fa→#34d399）、GitHub 风代码 palette、紫色左边框高亮块。适合开发者工作流 / MCP / Agent / dev tool 教程，类似 GitHub Blog / Linear Changelog。",
  "html-ppt-pitch-deck":
    "Investor-ready 10-slide HTML pitch deck — white + blue→purple gradient hero, big numbers, traction bar chart, $4.5M-style ask page. Use when the user wants a fundraising deck, seed-round pitch, or VC meeting slides.",
  "html-ppt-presenter-mode-reveal":
    '演讲者模式专用 deck — tokyo-night 默认主题，5 套主题 T 键切换，每页带 150-300 字逐字稿示例（<aside class="notes">），按 S 打开 popup（CURRENT / NEXT / SCRIPT / TIMER 四张磁吸卡片）。用于技术分享、公开演讲、课程讲解，怕忘词或要提词器的场景。',
  "html-ppt-product-launch":
    "Launch keynote deck — dark hero + light content, warm orange→peach accent, feature cards, pricing tiers, CTA. Use when announcing a product, launching a feature, or doing a keynote-style reveal.",
  "html-ppt-taste-brutalist":
    "16:9 HTML deck in tactical-telemetry / CRT-terminal taste. Deactivated-CRT charcoal slides, white-phosphor monospace, hazard-red accent, scanline overlay, ASCII syntax, density over decoration. Distilled from Leonxlnx/taste-skill `brutalist-skill` (Tactical Telemetry mode).",
  "html-ppt-taste-editorial":
    "16:9 HTML deck in editorial-minimalist taste. Warm cream slides, serif display + grotesque body, hairline rules, monospace meta, generous macro-whitespace, one accent. Distilled from Leonxlnx/taste-skill `minimalist-skill`.",
  "html-ppt-tech-sharing":
    "Conference / internal tech-talk deck — GitHub-dark, JetBrains Mono, terminal code blocks, agenda + Q&A pages. Use for engineering presentations, internal sharing sessions, conference talks, and code-heavy walkthroughs.",
  "html-ppt-testing-safety-alert":
    "红琥珀警示 deck — 顶/底 45° 红黑 hazard 条纹、红色删除线否定标题、L1/L2/L3 绿/琥珀/红 tier 卡片、圆点状态 alert box、policy-yaml 代码块（红左边框 + bad 关键词高亮）、红绿 checklist、Q1 事故堆叠柱状图。适合安全 / 风险 / 事故复盘 / 红队 / 上线前 AI 评审 / policy-as-code。",
  "html-ppt-weekly-report":
    "Team weekly / status-update deck — corporate clarity, 8-cell KPI grid, shipped list, 8-week bar chart, next-week table. Use for 周报, business reviews, team status updates, and exec dashboards.",
  "html-ppt-xhs-pastel-card":
    '柔和马卡龙慢生活 deck — 奶油 #fef8f1 底 + 三个柔光 blob、Playfair 斜体衬线 display 标题混 sans 正文、28px 圆角马卡龙卡片（桃 / 薄荷 / 天 / 紫 / 柠 / 玫）、Playfair 斜体 01-04 序号、SVG donut 图、chip+page 顶栏。适合生活方式 / 个人成长 / 慢生活 / 情绪类内容，"杂志、手作、不太科技"的感觉。',
  "html-ppt-xhs-post":
    "小红书 / Instagram 风 9 页 3:4 竖版图文（810×1080）— 暖色 pastel、虚线 sticker 卡片、底部页码点点。用于发小红书图文、Instagram carousel、品牌种草内容。",
  "html-ppt-xhs-white-editorial":
    "白底杂志风 deck — 纯白背景 + 顶部 10 色彩虹 bar、80-110px display 标题、紫→蓝→绿→橙→粉渐变文字、马卡龙软卡片组（粉/紫/蓝/绿/橙）、黑底白字 .focus pill、引用大块。同时适合发小红书图文 + 横版 PPT 双用。",
  "html-ppt-zhangzara-8-bit-orbit":
    "8-Bit Orbit — Pixel-art neon arcade aesthetic on a deep navy void. Anything that should feel like a CRT screen at 2am: cyberpunk, gaming, web3, indie dev tools, hackathon demos.",
  "html-ppt-zhangzara-biennale-yellow":
    "Biennale Yellow — Solar yellow on warm parchment with deep indigo serif and atmospheric sun-glow gradients. Anything that should feel like an art-biennale poster or a museum's annual programme: exhibition decks, arts-institution announcements, design conference brochures, curatorial pitches, literary publications, studio retrospectives.",
  "html-ppt-zhangzara-block-frame":
    "BlockFrame — Neobrutalist deck with pastel-neon color blocks and chunky black borders. Anything that should feel pop-graphic and design-led: indie SaaS launches, agency credentials, creative reviews, brand redesigns.",
  "html-ppt-zhangzara-blue-professional":
    "Blue Professional — Cream paper background with electric cobalt blue accents; clean modern professional. Anything that should feel modern-considered and lightly authoritative: B2B SaaS pitches, consulting deliverables, advisory updates, investor reports.",
  "html-ppt-zhangzara-bold-poster":
    "Bold Poster — Editorial poster aesthetic with massive Shrikhand display and a single fire-engine red accent. Anything that should land like a magazine cover: brand manifestos, founder vision decks, editorial / cultural pitches, creative reviews.",
  "html-ppt-zhangzara-broadside":
    "Broadside — Dark editorial canvas with a single fire orange accent and bilingual Latin/Chinese type stack. Anything that should land like a broadside newspaper headline: brand manifestos, magazine and cultural pitches, design talks, bilingual EN/CN decks, founder vision statements.",
  "html-ppt-zhangzara-capsule":
    "Capsule — Modular pill-shaped cards on warm bone with a full pastel-pop palette. Anything that should feel modular, modern, and a little Y2K: lifestyle brands, creator portfolios, DTC launches, beauty / wellness, agency credentials.",
  "html-ppt-zhangzara-cartesian":
    "Cartesian — Quiet warm-neutral palette with classical Playfair serifs; tasteful and unhurried. Anything that should feel quiet, considered, and grown-up: investment theses, white papers, advisory work, longform research, gallery / cultural decks.",
  "html-ppt-zhangzara-cobalt-grid":
    "Cobalt Grid — Electric cobalt italic serifs on a graph-paper canvas, anchored by stair-stepped pixel-glitch decorations and slim hairline rules. Anything that should feel like a quietly serious design / research bulletin, art publication, or curated trend report.",
  "html-ppt-zhangzara-coral":
    "Coral — Cream and coral on near-black, set in oversized Bebas Neue. Anything that should feel warm-graphic and editorial: fashion, beauty, fitness, F&B, lifestyle brands, agency credentials.",
  "html-ppt-zhangzara-creative-mode":
    "Creative Mode — Cream paper canvas with confident multi-color (green, pink, orange, yellow) accents and Archivo Black display. Anything that should feel design-led and confident: creative agency pitches, design studio decks, ad shop credentials, brand creative reviews, art-direction reviews.",
  "html-ppt-zhangzara-daisy-days":
    "Daisy Days — Cheerful pastel deck with hand-drawn daisies, stars, and rainbows. Friendly, soft, and warm. Anything that should feel friendly, soft, and joyful: educational content, kids and family, wellness programs, community workshops, creator portfolios for craft / illustration.",
  "html-ppt-zhangzara-editorial-tri-tone":
    "Editorial Tri-Tone — Three-color editorial system: dusty pink, mustard cream, and deep burgundy, set in Bricolage + Instrument Serif. Anything that should feel like a fashion-magazine spread: editorial pitches, fashion brand decks, lifestyle media, art direction reviews.",
  "html-ppt-zhangzara-grove":
    "Grove — Forest-green canvas with cream type, classical Playfair serifs, and a single rust accent. Anything that should feel organic, considered, and grown-up: sustainability and wellness brands, outdoor / nature products, wineries and restaurants, literary or arts decks, advisory deliverables, bilingual EN/CN reports.",
  "html-ppt-zhangzara-long-table":
    "Long Table — Warm cream and rust-red supper-club aesthetic with bold uppercase grotesk headlines, italic Fraunces, and pill-shaped outlined buttons. Anything that should feel like a warm, intimate, modern hospitality / community brand: supper clubs, dinner series, small restaurants, creative-studio events, membership pitches, lifestyle and wine brands.",
  "html-ppt-zhangzara-mat":
    "Mat — Dark sage canvas with bone paper and burnt-orange accent; mid-century modern with wood undertones. Anything that should feel mid-century, tactile, and intentional: design studio credentials, architecture / interior brands, ceramics / craft / furniture, advisory decks.",
  "html-ppt-zhangzara-monochrome":
    "Monochrome — Ivory ledger paper with all-black type; Lora serif headlines, Jost body, no color at all. Anything that should feel like a hand-typeset ledger: user research synthesis, white papers, longform reports, academic and policy briefs, advisory deliverables, bilingual EN/CN reports.",
  "html-ppt-zhangzara-neo-grid-bold":
    "Neo-Grid Bold — Editorial neo-brutalism with a single neon yellow accent on off-white paper. Anything that should feel confident and editorial-graphic: design-led pitches, brand work, founder talks, conference keynotes.",
  "html-ppt-zhangzara-peoples-platform":
    "People's Platform (Block & Bold) — Activist poster energy: blue, orange, red on cream, with Alfa Slab + Caveat Brush. Anything that should feel honest, loud, and graphic: cultural commentary, manifestos, civic and community decks, design talks, campaign pitches.",
  "html-ppt-zhangzara-pin-and-paper":
    "Pin & Paper — Yellow paper with safety-pin illustrations, ink-blue handwritten Caveat, paper-grain texture. Anything that should feel hand-crafted, warm, and literary: qualitative research findings, founder reflections, longform brand stories, workshop debriefs.",
  "html-ppt-zhangzara-pink-script":
    "Pink Script — After Hours — Black canvas, hot pink accent, pearl-cream paper, Instrument Serif headlines: late-night editorial luxury. Anything that should feel nocturnal, intentional, and a little luxe: fashion brand decks, creator personal brands, after-hours / nightlife / spirits launches, luxury product reveals, editorial features.",
  "html-ppt-zhangzara-playful":
    "Playful — Sun-warm peach background with Syne display: a friendly indie launch deck. Anything that should feel warm, indie, and approachable: creator portfolios, indie product launches, lifestyle brands, small-business pitches, newsletter / community decks.",
  "html-ppt-zhangzara-raw-grid":
    "Raw Grid — Neo-brutalist deck with thick borders, offset shadows, and a pink/sage/ink palette. Anything that should feel direct and graphic-confident: founder pitches, accelerator demos, brand decks, indie launches, creator portfolios.",
  "html-ppt-zhangzara-retro-windows":
    "Retro Windows — Windows 95 chrome: gray title bars, MS Sans Serif, pixel typography, full nostalgia. Anything that should feel knowingly nostalgic: retro gaming, Y2K-aesthetic brands, creator portfolios with a 90s vibe, tech-history talks, deliberately tongue-in-cheek decks.",
  "html-ppt-zhangzara-sakura-chroma":
    "Sakura Chroma — Vintage Japanese cassette-package aesthetic: cream paper, diagonal rainbow ribbons, condensed bold type, JIS-style spec checkboxes. Anything that should feel like a vintage Japanese cassette package or a TDK / Sony / Sakura Color product catalogue: indie hardware brand decks, music-label release schedules, analog studio retrospectives, zine and magazine pitches, kawaii-tech product launches, creative-studio annual reports.",
  "html-ppt-zhangzara-scatterbrain":
    "Scatterbrain — Post-it inspired: pastel sticky notes, Caveat handwriting, Shrikhand and Zilla Slab type stack. Anything that should feel like a designer's whiteboard: brainstorms, workshops, creative-agency credentials, design-thinking sessions, ideation pitches, art-direction reviews.",
  "html-ppt-zhangzara-signal":
    "Signal — Deep navy canvas with bone paper and a single muted-gold accent; institutional with quiet weight. Anything that should feel weighty, considered, and credibly institutional: investor decks, board presentations, consulting deliverables, legal / policy briefs, advisory pitches.",
  "html-ppt-zhangzara-soft-editorial":
    "Soft Editorial — Cormorant Garamond serif on warm paper with sage, blush, and lemon accents. Anything that should feel literary, elegant, and unhurried: editorial features, longform brand stories, gallery / museum decks, advisory deliverables, wedding / lifestyle media, founder essays.",
  "html-ppt-zhangzara-stencil-tablet":
    "Stencil & Tablet — Bone paper with stencil-cut headlines and a six-color earth palette: archaeology meets brand. Anything that should feel archival, tactile, and weighty-graphic: museum and cultural-institution decks, art / architecture brands, longform research, heritage and craft brands, manifestos.",
  "html-ppt-zhangzara-studio":
    "Studio — Black canvas with electric-yellow type; high-voltage design studio aesthetic. Anything that should feel electric and design-led: studio credentials, creative agency pitches, brand showcases, art-direction reviews, fashion / sneaker brand work.",
  "html-ppt-zhangzara-vellum":
    "Vellum — Deep navy canvas with warm-yellow italic Cormorant serifs and a single dusty teal accent. A quiet, scholarly aesthetic. Anything that should feel scholarly, literary, and quietly intelligent: research synthesis, white papers, academic and policy briefs, advisory deliverables, longform editorial pieces, founder reflections.",
  hyperframes:
    "Create video compositions, animations, title cards, overlays, captions, voiceovers, audio-reactive visuals, and scene transitions in HyperFrames HTML. Use when asked to build any HTML-based video content, add captions or subtitles synced to audio, generate text-to-speech narration, create audio-reactive animation (beat sync, glow, pulse driven by music), add animated text highlighting (marker sweeps, hand-drawn circles, burst lines, scribble, sketchout), or add transitions between scenes (crossfades, wipes, reveals, shader transitions). Covers composition authoring, timing, media, and the full video production workflow. For CLI commands (init, lint, preview, render, transcribe, tts) see the hyperframes-cli skill.",
  "ib-pitch-book":
    "Investment-banking pitch book for strategic alternatives — trading comps, precedent transactions, valuation football field, DCF sensitivity, strategic-options matrix, process recommendation. Built by adapting `assets/template.html` so IB-specific chrome, disclosure bands, and source labels are preserved. Use for Board / sell-side discussion materials. Not a VC fundraising deck (see html-ppt-pitch-deck). Workflow adapted from Anthropic financial-services Pitch Agent (Apache-2.0).",
  "image-poster":
    "Single-image generation skill for posters, key art, and editorial illustrations. Defaults to gpt-image-2 but is provider-agnostic — the same workflow drives Flux, Imagen, or Midjourney via the active upstream tooling. Output is one or more PNG/JPEG files saved to the project folder.",
  invoice:
    'A printable invoice page — sender + recipient block, line items table, tax breakdown, totals, and payment instructions. Use when the brief mentions "invoice", "bill", "billing statement", or "发票".',
  "kami-deck":
    "Produce a print-grade slide deck in the kami (紙 / 纸) design system — warm parchment background (or ink-blue for cover / chapter slides), serif at one weight, ink-blue accent ≤ 5% per slide, no italic. Horizontal magazine swipe pagination (←/→ · wheel · swipe · ESC overview). One self-contained HTML file, zero dependencies beyond Google Fonts.",
  "kami-landing":
    "Produce a print-grade single-page kami (紙 / 纸) document — warm parchment canvas, ink-blue accent, serif at one weight, no italic, no cool grays. The output reads like a professional white paper or studio one-pager, not an app UI. Multilingual by design (EN · zh-CN · ja). One self-contained HTML file, zero dependencies.",
  "kanban-board":
    'Kanban / task board with columns (To do / In progress / In review / Done), draggable-looking cards, assignee avatars, swimlanes, and a top filter bar. Use when the brief mentions "kanban", "task board", "sprint board", "trello", "看板".',
  last30days:
    "Recent community and social trend research over the last 30 days. Use when the brief asks what people are saying now, recent sentiment, community reactions, social proof, launch reaction, trend scan, or last-30-days context.",
  "live-artifact":
    "Create refreshable, auditable Open Design artifacts backed by connector or local data. Trigger when the user asks for live dashboards, refreshable reports, synced views, or reusable data-backed artifacts.",
  "live-dashboard":
    "Notion-style team dashboard rendered as a Live Artifact. A single-page, self-contained HTML dashboard with KPIs, a 7-day sparkline, a real-time activity feed and a linked-database task table — wired to Notion via the Composio connector catalog. Refreshes on demand and when the artifact is opened. Falls back to seeded mock data when no connector is bound, so it works offline / in screenshots / in the picker preview.",
  "magazine-poster":
    'An editorial-style poster — newsprint paper, dateline, oversized serif headline with a struck-through word and italic accent, a 2-column body block, and 6 numbered sections with annotated pull-quote captions. Reads like a Sunday-paper full-page essay or a thoughtful launch poster. Use when the brief asks for "magazine poster", "editorial poster", "newsprint", "essay layout", or "manifesto".',
  "meeting-notes":
    'Meeting notes page — title bar with attendees, agenda checklist, decisions block, action items table with owners + dates, and a "next meeting" footer. Use when the brief mentions "meeting notes", "minutes", "1:1 notes", "all-hands recap", or "会议纪要".',
  "mobile-onboarding":
    'A multi-screen mobile onboarding flow rendered as three phone frames side by side — splash, value-prop, sign-in. Status bar, swipe dots, primary CTA. Use when the brief mentions "mobile onboarding", "iOS onboarding", "phone signup", or "移动端引导".',
  "motion-frames":
    'A single-frame motion-design composition with looping CSS animations — rotating type ring, animated globe, ticking timer, parallax labels. Renders as a hero video poster you can hand straight to HyperFrames or any keyframe-based exporter. Use when the brief asks for "motion design", "animated hero", "loop", "video poster", "title card", or pairs Open Claude Design with HyperFrames for a kinetic export.',
  "open-design-landing":
    "Produce a world-class single-page editorial landing site in the Atelier Zero visual language (Monocle / Apartamento / Études editorial collage) — the same aesthetic Open Design uses for its own marketing surface. The agent fills a typed `inputs.json` from a brand brief, optionally generates 16 collage assets via gpt-image-2, then runs a pure-function composer that emits a self-contained HTML file; a separate path can mirror the Astro marketing site in `apps/landing-page/`. Drop-in scroll-reveal motion and a Headroom-style sticky nav are wired automatically.",
  "open-design-landing-deck":
    "Produce a single-file slide deck in the Atelier Zero visual language (warm-paper background, italic-serif emphasis spans, coral terminating dots, surreal collage plates) — Open Design's brand deck recipe. The deck uses **horizontal magazine-style swipe pagination** (←/→, wheel, swipe), a per-slide chrome strip with brand mark and slide counter, an ESC overview grid, a coral progress bar, and inherits the canonical stylesheet + 16-slot image library from the sister `open-design-landing` skill.",
  "orbit-general":
    "Open Orbit briefing skill — selected by the Orbit pipeline when the user has two or more connectors connected. Pulls the past 24 hours of activity from every authenticated connector (GitHub, Linear, Notion, Slack, 飞书, Calendar, Gmail, Drive, Sentry, Vercel, …) and renders a single adaptive bento-grid dashboard at the top of \"我的设计\". Each connector module picks its own UI form (list, avatar stack, status ring, heatmap, file grid, alert card, …) based on the data shape it returns, so the layout scales as Orbit's connector ecosystem grows. This skill should not be triggered manually — it is invoked by Orbit's daily-digest scheduler against the user's live connector data.",
  "orbit-github":
    "Open Orbit briefing skill — selected by the Orbit pipeline when GitHub is the user's only connected connector, or when the user explicitly scopes their daily digest to GitHub. Pulls the past 24 hours of PRs, review requests, issues, CI runs, and merges from the user's authenticated GitHub connection and renders them in a layout that mirrors GitHub's native Notifications + PR-diff visual language. This skill should not be triggered manually — it is invoked by Orbit's daily-digest scheduler against live GitHub data.",
  "orbit-gmail":
    "Open Orbit briefing skill — selected by the Orbit pipeline when Gmail is the user's only connected connector, or when the user explicitly scopes their daily digest to Gmail. Pulls the past 24 hours of inbox activity (replies awaited, mentions, cc, auto- categorized bulk) from the user's authenticated Gmail connection and renders the digest as the Orbit Daily Digest email opened inside Gmail's reading view. This skill should not be triggered manually — it is invoked by Orbit's daily-digest scheduler against live Gmail data.",
  "orbit-linear":
    "Open Orbit briefing skill — selected by the Orbit pipeline when Linear is the user's only connected connector, or when the user explicitly scopes their daily digest to Linear. Pulls the past 24 hours of issue movement, status changes, assignments, and cycle progress from the user's authenticated Linear connection and renders the digest in Linear's native Inbox + cycle-progress visual language. This skill should not be triggered manually — it is invoked by Orbit's daily-digest scheduler against live Linear data.",
  "orbit-notion":
    "Open Orbit briefing skill — selected by the Orbit pipeline when Notion is the user's only connected connector, or when the user explicitly scopes their daily digest to Notion. Pulls the past 24 hours of document edits, comments, mentions, and database row changes from the user's authenticated Notion connection and renders the digest as a native Notion page (callout / toggle / database table primitives). This skill should not be triggered manually — it is invoked by Orbit's daily-digest scheduler against live Notion data.",
  "pm-spec":
    'Product spec / PRD as a single page — problem, success metrics, scope, user stories, design notes, rollout plan, open questions. Use when the brief mentions "PRD", "spec", "product spec", "feature brief", or "需求文档".',
  "pricing-page":
    'A standalone pricing page — header, plan tiers, feature comparison table, and an FAQ. Use when the brief asks for "pricing", "plans", "subscription tiers", or a "compare plans" page.',
  "replit-deck":
    'Single-file horizontal-swipe HTML deck in the style of Replit Slides\'s landing-page template gallery. Eight distinct themes (helix, holm, vance, bevel, world-dark, world-mint, atlas, bluehouse) — each a complete visual system (palette + type + accent) captured from replit.com/slides. Pick one theme, do not mix. For pitch decks, board reports, brand memos, campaign reveals — when the user explicitly wants "Replit Slides style".',
  "saas-landing":
    'Single-page SaaS landing with hero, features, social proof, pricing, and CTA. Respects the active DESIGN.md color/typography/layout tokens. Trigger keywords: "saas landing", "marketing page", "product landing".',
  "simple-deck":
    "Single-file horizontal-swipe HTML deck. Built by copying the seed `assets/template.html` (which carries the proven 5-rule iframe nav script) and pasting slide layouts from `references/layouts.md`. Pitch decks, product overviews, study material — when you don't need the magazine aesthetic of `magazine-web-ppt`.",
  "social-carousel":
    'A three-card social-media carousel laid out as 1080×1080 squares — three cinematic, on-brand panels with display headlines that connect across the series ("onwards." → "to the next one." → "looking ahead."). Each card has a brand mark, a number / total, a caption, and a "loop" affordance. Use when the brief asks for a "carousel post", "social carousel", "Instagram carousel", "LinkedIn series", "X thread cards", or "三连发".',
  "social-media-dashboard":
    'Creator-facing social media analytics dashboard in a single HTML file. A platform switcher (X / LinkedIn / YouTube / Instagram), a row of KPI cards (followers, engagement rate, likes, reposts), a follower-growth chart, a "top post this week" preview, and a trending topics / top comments side panel. Use when the brief mentions a "social media dashboard", "creator analytics", "social analytics", or names specific platforms (X, Twitter, LinkedIn, YouTube, Instagram, TikTok) together with metrics like followers, engagement, likes, reposts.',
  "social-media-matrix-tracker-template":
    "社媒矩阵数据追踪面板模板（Social Media Matrix Tracker）。 Use when users ask for a cinematic, data-dense social media analytics dashboard with multi-platform metrics, interactive charts, hover insights, range compare, and dark/light theme switching in a single HTML artifact.",
  "sprite-animation":
    'A pixel / sprite-style animated explainer slide — full-bleed cream stage, bold display year, animated pixel-art mascot (e.g. Hanafuda card, mushroom, or 8-bit console), kinetic Japanese display type, ticking timeline ribbon. Reads like a single frame of an educational motion video — looping CSS keyframes, no JS, ready to be screen-recorded into a vertical video. Use when the brief asks for a "sprite animation", "pixel-art video", "8-bit explainer", "history of X explainer", "kinetic typography history", "Nintendo-style", "精灵图动画", "像素动画", or "复古动画".',
  "team-okrs":
    'OKR tracker page — quarter banner, three objectives with their key results as progress bars, owner avatars, status pills, and a "this quarter at a glance" sidebar. Use when the brief mentions "OKRs", "key results", "objectives", or "目标".',
  "trading-analysis-dashboard-template":
    "Professional trading analysis dashboard template (single-file HTML) with light/dark theme switch, dense market panels, chart interactions, demo/live playback, and command palette behavior. Use when users ask for a Wall-Street-style analytics terminal, trading cockpit, or high-tech financial dashboard template with realistic data layout.",
  tweaks:
    'Wrap any HTML artifact with a side panel of live, parameterized controls — accent color, type scale, density, motion, theme — that rewrite CSS custom properties in real time and persist to localStorage. Lets the user explore variants of a design without re-prompting the agent. Use when the brief asks for "variants", "side-by-side options", "tweak this", "let me adjust", "live knobs", or "实时调参".',
  "video-shortform":
    "Short-form video generation skill — 3-10 second clips for product reveals, motion teasers, ambient loops. Defaults to Seedance 2 but works the same with Kling 3 / 4, Veo 3 or Sora 2. Output is one MP4 saved to the project folder. When the workspace also ships an interactive-video / hyperframes skill, prefer composing several short shots into a single timeline rather than one long monolithic clip.",
  "waitlist-page":
    "Minimal pre-launch landing with email capture, brand logo, and optional decorative layer. Reads DESIGN.md for colors, typography, and layout rules. Best for: product launches, beta signups, early access programs, indie projects.",
  "web-prototype":
    "General-purpose desktop web prototype. Single self-contained HTML file built by copying the seed `assets/template.html` and pasting section layouts from `references/layouts.md`. Default for any landing / marketing / docs / SaaS page when no more specific skill matches.",
  "web-prototype-taste-brutalist":
    "Swiss industrial-print web prototype. Newsprint canvas, monolithic black grotesque, viewport-bleeding numerals, hairline grid dividers, hazard-red accent, ASCII syntax decoration. Distilled from Leonxlnx/taste-skill `brutalist-skill` (Swiss Industrial Print mode).",
  "web-prototype-taste-soft":
    "Apple-tier soft web prototype. Silver/cream canvas, double-bezel cards, button-in-button CTAs, generous squircle radii, spring motion, ambient mesh. Distilled from Leonxlnx/taste-skill `soft-skill` + sections 4–8 of `taste-skill`.",
  "wireframe-sketch":
    'A hand-drawn wireframe exploration — graph-paper background, marker / pencil tone, multiple tab labels for variants, sticky-note annotations, scribbled chart placeholders, hatched fills. Reads like a designer\'s whiteboard before any pixels are committed. Use when the brief asks for "wireframe", "sketch wireframe", "hand-drawn", "lo-fi", "whiteboard", "草稿", or "手绘原型".',
  "x-research":
    "X/Twitter public sentiment research for recent market, company, product, or community discourse. Use when the brief asks what people are saying on X, Twitter sentiment, CT sentiment, public opinion, expert posts, or social reaction around a stock, sector, company, product, or market event.",
} as const;

const ADDITIONAL_OPEN_DESIGN_DESIGN_SYSTEM_DESCRIPTIONS = {
  agentic:
    "Conversational AI-first interface with minimal controls, clear outcomes, and delegated task flows for agentic workflows.",
  airbnb:
    "Travel marketplace. Warm coral accent, photography-driven, rounded UI.",
  airtable:
    "Spreadsheet-database hybrid. Colorful, friendly, structured data aesthetic.",
  ant: "Structured, enterprise-focused design system emphasizing clarity, consistency, and efficiency for data-dense web applications.",
  application:
    "App dashboard with purple-themed aesthetic, top-bar navigation, card-based layouts, and developer-first workflows.",
  arc: '"The browser that browses for you." Translucent surfaces, gradient warmth, sidebar-first layout.',
  artistic:
    "High-contrast, expressive style with creative typography and bold color choices for visually striking interfaces.",
  "atelier-zero":
    "A magazine-grade, collage-driven visual system: warm paper canvas, surreal",
  bento:
    "Modular grid layout with card-like blocks, clear hierarchy, soft spacing, and subtle visual contrast for organized, scannable interfaces.",
  binance:
    "Crypto exchange. Bold yellow accent on monochrome, trading-floor urgency.",
  bmw: "Luxury automotive. Dark premium surfaces, precise German engineering aesthetic.",
  "bmw-m":
    "Motorsport performance sub-brand. Near-black cockpit surfaces, BMW M tricolor accents, sharp engineering geometry.",
  bold: "Strong visual presence with heavyweight typography, high-contrast colors, and commanding layouts.",
  brutalism:
    "Raw, anti-design aesthetic inspired by concrete architecture with unadorned elements, jarring layouts, and functional minimalism.",
  bugatti:
    "Hypercar brand. Cinema-black canvas, monochrome austerity, monumental display type.",
  cafe: "Cozy cafe-inspired interface with warm tones, soft typography, and clean layouts for a relaxed browsing experience.",
  cal: "Open-source scheduling. Clean neutral UI, developer-oriented simplicity.",
  canva:
    "Visual creation platform. Vivid purple-blue gradient, generous spacing, friendly geometry.",
  cisco:
    "Enterprise infrastructure brand. Dark trust surfaces, Cisco Blue signal, technical clarity.",
  claude:
    "Anthropic's AI assistant. Warm terracotta accent, clean editorial layout.",
  clay: "Creative agency. Organic shapes, soft gradients, art-directed layout.",
  claymorphism:
    "Soft, rounded 3D-like shapes mimicking malleable clay with playful, puffy elements and colorful surfaces.",
  clean:
    "Simplicity-focused design with ample whitespace, legible typography, and a limited color palette to reduce visual clutter.",
  clickhouse:
    "Fast analytics database. Yellow-accented, technical documentation style.",
  cohere:
    "Enterprise AI platform. Vibrant gradients, data-rich dashboard aesthetic.",
  coinbase:
    "Crypto exchange. Clean blue identity, trust-focused, institutional feel.",
  colorful:
    "Vibrant, high-contrast palettes and gradients for engaging, memorable, and modern user experiences.",
  composio:
    "Tool integration platform. Modern dark with colorful integration icons.",
  contemporary:
    "Current-era minimalist design with bento grids, dark mode support, and high-performance accessible layouts.",
  corporate:
    "Professional, brand-aligned design with structured grids, minimalist layouts, and consistent enterprise patterns.",
  cosmic:
    "Futuristic sci-fi aesthetic with dark themes, vibrant neon accents, and immersive spatial elements.",
  creative:
    "Playful, character-driven design with expressive typography and bold graphics for landing pages and creative projects.",
  cursor: "AI-first code editor. Sleek dark interface, gradient accents.",
  default:
    "A clean, product-oriented default. Use when the brief doesn't call for a",
  discord:
    "Voice / chat platform. Deep blurple, dark-first surfaces, playful accent moments.",
  dithered:
    "Dot-pattern rendering technique that simulates shades with a limited palette for nostalgic, retro, high-contrast visuals.",
  doodle:
    "Hand-drawn, sketch-like style with doodles, handwritten fonts, and imperfect lines for a playful, informal feel.",
  dramatic:
    "High-contrast, theatrical design with bold layouts, immersive visuals, and unconventional compositions that command attention.",
  duolingo:
    "Language-learning platform. Bright owl green, chunky shadows, gamified joy.",
  elegant:
    "Graceful, refined aesthetic with delicate typography, minimal palettes, and polished layouts that exude sophistication.",
  elevenlabs:
    "AI voice platform. Dark cinematic UI, audio-waveform aesthetics.",
  energetic:
    "Dynamic, vibrant style with thick borders, geometric shapes, high-contrast colors, and expressive typography conveying motion and vitality.",
  enterprise:
    "Clean, high-contrast enterprise design for data-driven workflows with intuitive drag-and-drop patterns and structured layouts.",
  expo: "React Native platform. Dark theme, tight letter-spacing, code-centric.",
  expressive:
    "Vibrant, personality-driven design with bold colors, playful graphics, and dynamic layouts that balance creativity with structure.",
  fantasy:
    "Game-inspired fantasy aesthetic with bold, premium visuals, rich color palettes, and immersive thematic elements.",
  ferrari:
    "Luxury automotive. Chiaroscuro editorial, Ferrari Red accents, cinematic black.",
  figma:
    "Collaborative design tool. Vibrant multi-color, playful yet professional.",
  flat: "Two-dimensional minimalist style with vibrant colors, clean typography, and no 3D effects for fast, user-friendly interfaces.",
  framer: "Website builder. Bold black and blue, motion-first, design-forward.",
  friendly:
    "Approachable, intuitive design with rounded elements, ample whitespace, and soft pastel color palettes.",
  futuristic:
    "Forward-looking design with tech-inspired typography, modern layouts, and a sleek, innovation-driven aesthetic.",
  github:
    "Code-forward platform. Functional density, blue-on-white precision, Primer foundations.",
  glassmorphism:
    "Frosted glass effect with translucent layers, subtle blur, and luminous borders for depth and modern elegance.",
  gradient:
    "Smooth color transitions and gradient-rich surfaces for modern, playful interfaces with visual depth.",
  hashicorp: "Infrastructure automation. Enterprise-clean, black and white.",
  hud: "Fighter jet / helicopter head-up display. Phosphor green on near-black, all-caps data overlays, angular geometry. Zero ambiguity at speed and altitude.",
  huggingface:
    "ML community hub. Sunny yellow accent, monospace identity, cheerful and dense.",
  ibm: "Enterprise technology. Carbon design system, structured blue palette.",
  intercom:
    "Customer messaging. Friendly blue palette, conversational UI patterns.",
  kami: "Editorial paper system: warm parchment canvas, ink-blue accent, serif-led hierarchy. Built for resumes, one-pagers, white papers, portfolios, slide decks — anything that should feel like high-quality print rather than UI. Multilingual by design (EN · zh-CN · ja).",
  kraken: "Crypto trading. Purple-accented dark UI, data-dense dashboards.",
  lamborghini:
    "Supercar brand. True black surfaces, gold accents, dramatic uppercase typography.",
  levels:
    "Conversion-focused design that removes friction and guides users toward action through clarity, trust, and speed.",
  "linear-app": "Project management. Ultra-minimal, precise, purple accent.",
  lingo:
    "Playful, minimal design with bright colors, rounded shapes, tactile 3D borders, and friendly illustrations for approachable interfaces.",
  loom: "Loom async video. Purple primary, friendly surfaces, video-first layout. Clean and professional without being corporate.",
  lovable: "AI full-stack builder. Playful gradients, friendly dev aesthetic.",
  luxury:
    "High-end dark aesthetic with bold headings, monochromatic palette, and premium feel for luxury brand experiences.",
  mastercard:
    "Global payments network. Warm cream canvas, orbital pill shapes, editorial warmth.",
  material:
    "Google's Material Design with layered surfaces, dynamic theming, built-in motion, and responsive cross-platform patterns.",
  meta: "Tech retail store. Photography-first, binary light/dark surfaces, Meta Blue CTAs.",
  minimal:
    "Stripped-back design emphasizing whitespace, clean typography, and restrained color for maximum clarity and focus.",
  minimax: "AI model provider. Bold dark interface with neon accents.",
  mintlify: "Documentation platform. Clean, green-accented, reading-optimized.",
  miro: "Visual collaboration. Bright yellow accent, infinite canvas aesthetic.",
  "mission-control":
    "Space/aerospace mission monitoring. Dark command center, amber telemetry, monospace precision. Functional clarity above all else.",
  "mistral-ai":
    "Open-weight LLM provider. French-engineered minimalism, purple-toned.",
  modern:
    "Contemporary editorial style with serif typography, minimal palettes, and clean layouts for polished digital products.",
  mongodb:
    "Document database. Green leaf branding, developer documentation focus.",
  neobrutalism:
    "Modern take on brutalism with bold borders, vivid accent colors, and raw, high-contrast layouts on warm surfaces.",
  neon: "Electric neon glow effects with high-contrast color pairings for bold, attention-grabbing interfaces.",
  neumorphism:
    "Soft, extruded UI elements with inner and outer shadows on monochromatic surfaces for a tactile, embedded look.",
  nike: "Athletic retail. Monochrome UI, massive uppercase type, full-bleed photography.",
  notion:
    "All-in-one workspace. Warm minimalism, serif headings, soft surfaces.",
  nvidia: "GPU computing. Green-black energy, technical power aesthetic.",
  ollama: "Run LLMs locally. Terminal-first, monochrome simplicity.",
  openai:
    "Calm, near-monochrome system anchored in deep teal-black with generous white space and editorial typography.",
  "opencode-ai": "AI coding platform. Developer-centric dark theme.",
  pacman:
    "Retro arcade-inspired design with pixel fonts, dotted borders, playful high-contrast colors, and 8-bit game aesthetics.",
  paper:
    "Paper-textured, print-inspired design with minimal colors, clean serif/sans typography, and tactile surface qualities.",
  perplexity:
    "Conversational AI search engine. Deep-dark canvas, sharp typography, single violet accent, dense information hierarchy.",
  perspective:
    "Spatial depth design with isometric views, vanishing points, and layered elements that guide attention through 3D-like realism.",
  pinterest: "Visual discovery. Red accent, masonry grid, image-first.",
  playstation:
    "Gaming console retail. Three-surface channel layout, quiet-authority display type, cyan hover-scale.",
  posthog:
    "Product analytics. Playful hedgehog branding, developer-friendly dark UI.",
  premium:
    "Apple-inspired premium aesthetic with precise spacing, modern typography, and a refined, polished visual language.",
  professional:
    "Polished, business-ready design with modern typography, structured layouts, and a trustworthy visual identity.",
  publication:
    "Print-inspired visual language for books, magazines, and reports with editorial grids and expressive typography.",
  raycast:
    "Productivity launcher. Sleek dark chrome, vibrant gradient accents.",
  refined:
    "Carefully curated, modern minimal style with elegant serif typography and understated, sophisticated palettes.",
  renault:
    "French automotive. Vibrant aurora gradients, NouvelR typography, bold energy.",
  replicate: "Run ML models via API. Clean white canvas, code-forward.",
  resend: "Email API. Minimal dark theme, monospace accents.",
  retro:
    "Throwback design with vintage-inspired typography, high-contrast retro palettes, and nostalgic visual elements.",
  revolut:
    "Digital banking. Sleek dark interface, gradient cards, fintech precision.",
  runwayml: "AI video generation. Cinematic dark UI, media-rich layout.",
  sanity: "Headless CMS. Red accent, content-first editorial layout.",
  sentry: "Error monitoring. Dark dashboard, data-dense, pink-purple accent.",
  shadcn:
    "Shadcn/ui-inspired design with minimal, clean components, monochrome palette, and utility-first patterns.",
  shopify:
    "E-commerce platform. Dark-first cinematic, neon green accent, ultra-light type.",
  simple:
    "Straightforward, no-frills design with clean typography, neutral colors, and intuitive layouts that stay out of the way.",
  skeumorphism:
    "Real-world mimicry with textured surfaces, 3D effects, and familiar physical metaphors for intuitive digital interfaces.",
  slack:
    "Workplace communication platform. Aubergine-primary, multi-accent logo palette, light surfaces with dark sidebar, warm and approachable.",
  sleek:
    "Modern minimalist aesthetic with clean lines, intentional color palette, subtle interactions, and consistent spacing.",
  spacex:
    "Space technology. Stark black and white, full-bleed imagery, futuristic.",
  spacious:
    "Generous whitespace, consistent padding, and grid-based layouts for clean, readable, and breathing interfaces.",
  spotify:
    "Music streaming. Vibrant green on dark, bold type, album-art-driven.",
  starbucks:
    "Global coffee retail brand. Four-tier green system, warm cream canvas, full-pill buttons.",
  storytelling:
    "Narrative-driven design using visuals, copy, and interaction to guide users through engaging, emotionally resonant journeys.",
  stripe:
    "Payment infrastructure. Signature purple gradients, weight-300 elegance.",
  supabase: "Open-source Firebase alternative. Dark emerald theme, code-first.",
  superhuman:
    "Fast email client. Premium dark UI, keyboard-first, purple glow.",
  tesla:
    "Electric automotive. Radical subtraction, full-viewport photography, near-zero UI.",
  tetris:
    "Classic block-game inspired design with playful colors, bold display fonts, and compact, high-energy layouts.",
  theverge:
    "Tech editorial media. Acid-mint and ultraviolet accents, Manuka display, rave-flyer story tiles.",
  "together-ai":
    "Open-source AI infrastructure. Technical, blueprint-style design.",
  "totality-festival":
    'A cosmic-premium, glassmorphic dark system that captures the visceral awe of a solar eclipse — obsidian surfaces, amber "corona" highlights, and cyan atmospheric accents.',
  uber: "Mobility platform. Bold black and white, tight type, urban energy.",
  urdu: "Urdu-first digital experiences with native RTL support,Nastaliq typography, and bilingual harmony.",
  vercel: "Frontend deployment. Black and white precision, Geist font.",
  vibrant:
    "Lively, colorful design with bold playful typography, warm accents, and dynamic visual energy.",
  vintage:
    "1950s-1990s nostalgia with skeuomorphic touches, grainy textures, retro color palettes, and pixel-style typography.",
  vodafone:
    "Global telecom brand. Monumental uppercase display, Vodafone Red chapter bands.",
  voltagent:
    "AI agent framework. Void-black canvas, emerald accent, terminal-native.",
  warp: "Modern terminal. Dark IDE-like interface, block-based command UI.",
  webex:
    "Collaboration platform. Momentum typography, blue action system, multi-user accent spectrum.",
  webflow:
    "Visual web builder. Blue-accented, polished marketing site aesthetic.",
  wechat:
    "Brand visual language for WeChat Mini Programs, official accounts, and open ecosystem extensions.",
  wired:
    "Tech magazine. Paper-white broadsheet density, custom serif display, mono kickers, ink-blue links.",
  wise: "Money transfer. Bright green accent, friendly and clear.",
  "x-ai": "Elon Musk's AI lab. Stark monochrome, futuristic minimalism.",
  xiaohongshu:
    "Lifestyle UGC social platform. Singular brand red, generous radius, content-first.",
  zapier: "Automation platform. Warm orange, friendly illustration-driven.",
} as const;

const OPEN_DESIGN_SKILL_ACRONYMS = new Set([
  "ai",
  "css",
  "d3",
  "doc",
  "docx",
  "faq",
  "gif",
  "gsap",
  "hig",
  "html",
  "md",
  "pdf",
  "ppt",
  "pptx",
  "ui",
  "ux",
  "vfx",
  "wpds",
]);

function titleCaseOpenDesignSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => {
      if (OPEN_DESIGN_SKILL_ACRONYMS.has(part)) {
        return part.toUpperCase();
      }

      if (/^[0-9]+d$/u.test(part)) {
        return part.toUpperCase();
      }

      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function addTarget(
  targets: OpenDesignTarget[],
  target: OpenDesignTarget,
): void {
  if (!targets.includes(target)) {
    targets.push(target);
  }
}

function inferOpenDesignSkillTargets(
  slug: string,
): readonly OpenDesignTarget[] {
  const targets: OpenDesignTarget[] = [];

  if (
    /video|remotion|sora|kling|lip|youtube|gif|stitch|hyperframes|orbit|speech|audio|music/u.test(
      slug,
    )
  ) {
    addTarget(targets, "intro-video");
  }

  if (/ppt|pptx|slides|deck|keynote|presentation/u.test(slug)) {
    addTarget(targets, "presentation");
  }

  if (
    /image|imagen|photo|illustration|poster|card|screenshot|frame|mockup|art|canvas|sticker|tryon|visual|creative|social|twitter|xiaohongshu/u.test(
      slug,
    )
  ) {
    addTarget(targets, "image");
    addTarget(targets, "poster");
    addTarget(targets, "website");
    addTarget(targets, "presentation");
  }

  if (
    /frontend|ui|ux|web|website|shadcn|three|gsap|shader|flutter|swift|app|login|paywall|figma|platform|browser/u.test(
      slug,
    )
  ) {
    addTarget(targets, "website");
    addTarget(targets, "mobile-app-design");
    addTarget(targets, "dashboard-design");
  }

  if (
    /doc|pdf|docx|report|article|copy|brand|brief|resume|faq|research|notes|markdown|release|guidelines|review/u.test(
      slug,
    )
  ) {
    addTarget(targets, "report");
    addTarget(targets, "docs-design");
    addTarget(targets, "website");
    addTarget(targets, "presentation");
  }

  if (targets.length === 0) {
    return ["presentation", "website", "poster", "report", "docs-design"];
  }

  return targets;
}

function inferOpenDesignSkillOutputKinds(
  slug: string,
): readonly GenerationOutputKind[] | undefined {
  const outputKinds: GenerationOutputKind[] = [];

  if (
    /image|imagen|photo|illustration|poster|card|screenshot|frame|mockup|art|canvas|sticker|tryon|visual/u.test(
      slug,
    )
  ) {
    outputKinds.push("image");
  }

  if (
    /video|remotion|sora|kling|lip|youtube|gif|stitch|hyperframes|orbit/u.test(
      slug,
    )
  ) {
    outputKinds.push("video");
  }

  if (/audio|speech|music/u.test(slug)) {
    outputKinds.push("audio");
  }

  if (/ppt|pptx|slides|deck|keynote|presentation/u.test(slug)) {
    outputKinds.push("presentation");
  }

  return outputKinds.length > 0 ? outputKinds : undefined;
}

function createOpenDesignSkillEntry(
  slug: (typeof STYLE_OPEN_DESIGN_SKILL_SLUGS)[number],
): OpenDesignRegistryEntry {
  const name = titleCaseOpenDesignSlug(slug);
  const outputKinds = inferOpenDesignSkillOutputKinds(slug);
  const primaryOutputKind = outputKinds?.[0];

  return {
    id: `od:skill:${slug}`,
    kind: "skill",
    name,
    description: STYLE_OPEN_DESIGN_SKILL_DESCRIPTIONS[slug],
    source: source(`skills/${slug}/SKILL.md`),
    targets: inferOpenDesignSkillTargets(slug),
    tags: slug.split("-").filter((tag) => {
      return tag.length > 1;
    }),
    triggers: [slug, name.toLowerCase()],
    ...(outputKinds && primaryOutputKind
      ? {
          outputKinds,
          primaryOutputKind,
        }
      : {}),
    executorHints: ["skill-authored"],
    status: "experimental",
    priority: -90,
  };
}

function inferOpenDesignTemplateTargets(
  slug: string,
): readonly OpenDesignTarget[] {
  const targets: OpenDesignTarget[] = [];

  if (/mobile|phone|app|onboarding|gamified/u.test(slug)) {
    addTarget(targets, "mobile-app-design");
  }

  if (/dashboard|admin|kanban|tracker|matrix|orbit|analytics/u.test(slug)) {
    addTarget(targets, "dashboard-design");
    addTarget(targets, "website");
  }

  if (/ppt|deck|slides|presentation|keynote/u.test(slug)) {
    addTarget(targets, "presentation");
  }

  if (
    /poster|image|sprite|wireframe|carousel|social|xhs|motion|video/u.test(slug)
  ) {
    addTarget(targets, "image");
    addTarget(targets, "poster");
    addTarget(targets, "website");
  }

  if (
    /docs|doc|report|runbook|spec|invoice|email|notes|blog|guide|case/u.test(
      slug,
    )
  ) {
    addTarget(targets, "report");
    addTarget(targets, "docs-design");
    addTarget(targets, "website");
  }

  if (targets.length === 0) {
    return ["website", "presentation", "report"];
  }

  return targets;
}

function createOpenDesignTemplateEntry(
  slug: string,
  description: string,
): OpenDesignRegistryEntry {
  const name = titleCaseOpenDesignSlug(slug);

  return {
    id: `od:template:${slug}`,
    kind: "template",
    name,
    description,
    source: source(`design-templates/${slug}`),
    targets: inferOpenDesignTemplateTargets(slug),
    tags: slug.split("-").filter((tag) => {
      return tag.length > 1;
    }),
    triggers: [slug, name.toLowerCase()],
    status: "experimental",
    priority: -90,
  };
}

function createOpenDesignDesignSystemEntry(
  slug: string,
  description: string,
): OpenDesignRegistryEntry {
  const name = titleCaseOpenDesignSlug(slug);

  return {
    id: `od:design-system:${slug}`,
    kind: "design-system",
    name,
    description,
    source: source(`design-systems/${slug}`),
    targets: [
      "presentation",
      "website",
      "dashboard-design",
      "mobile-app-design",
      "poster",
      "report",
      "docs-design",
    ],
    tags: slug.split("-").filter((tag) => {
      return tag.length > 1;
    }),
    triggers: [slug, name.toLowerCase()],
    status: "experimental",
    priority: -90,
  };
}

const OPEN_DESIGN_REGISTRY: readonly OpenDesignRegistryEntry[] = [
  {
    id: "od:skill:article-magazine",
    kind: "skill",
    name: "Article Magazine",
    description:
      "Shapes research or editorial material into a magazine-like narrative with strong hierarchy.",
    source: source("skills/article-magazine/SKILL.md"),
    targets: ["presentation", "website", "poster", "report", "docs-design"],
    tags: ["editorial", "magazine", "article", "narrative", "research"],
    triggers: ["magazine", "editorial", "story", "essay", "briefing"],
    bestFor: [
      "editorial reports",
      "narrative explainers",
      "research synthesis",
    ],
    status: "curated",
    priority: 28,
  },
  {
    id: "od:skill:design-brief",
    kind: "skill",
    name: "Design Brief",
    description:
      "Converts a product, brand, or feature request into a structured design brief.",
    source: source("skills/design-brief/SKILL.md"),
    targets: ["presentation", "website", "mobile-app-design", "docs-design"],
    tags: ["design", "brief", "product", "brand", "requirements"],
    triggers: ["design brief", "brand", "product direction", "requirements"],
    bestFor: ["product design briefs", "brand-driven websites"],
    status: "curated",
    priority: 16,
  },
  ...STYLE_OPEN_DESIGN_SKILL_SLUGS.map(createOpenDesignSkillEntry),
  {
    id: "od:template:dashboard",
    kind: "template",
    name: "Dashboard",
    description:
      "Admin or analytics dashboard in a single HTML file with fixed sidebar, top bar, KPI cards, and one or two charts.",
    source: source("design-templates/dashboard"),
    targets: ["website", "dashboard-design", "report"],
    tags: ["dashboard", "analytics", "kpi", "metrics", "operations", "table"],
    triggers: ["dashboard", "analytics", "monitoring", "metrics", "ops"],
    bestFor: ["metric-heavy pages", "status surfaces", "operational summaries"],
    compatibleWith: ["od:design-system:dashboard"],
    status: "curated",
    priority: 36,
  },
  {
    id: "od:template:finance-report",
    kind: "template",
    name: "Finance Report",
    description:
      "Quarterly or monthly financial report with masthead KPIs, revenue and burn charts, P&L summary, highlights, and outlook.",
    source: source("design-templates/finance-report"),
    targets: ["presentation", "website", "report"],
    tags: ["report", "finance", "executive", "table", "analysis", "sources"],
    triggers: ["report", "brief", "analysis", "top 10", "finance"],
    bestFor: ["source-backed reports", "executive summaries", "ranked lists"],
    compatibleWith: ["od:design-system:dashboard"],
    status: "curated",
    priority: 34,
  },
  {
    id: "od:template:docs-page",
    kind: "template",
    name: "Docs Page",
    description:
      "Documentation page with inline-start navigation, scrollable article body, and inline-end table of contents.",
    source: source("design-templates/docs-page"),
    targets: ["website", "docs-design", "report"],
    tags: ["docs", "explanation", "guide", "structured", "reference"],
    triggers: ["docs", "documentation", "guide", "explain", "how to"],
    bestFor: ["technical explainers", "product docs", "implementation notes"],
    compatibleWith: ["od:skill:design-brief", "od:design-system:mono"],
    status: "curated",
    priority: 26,
  },
  {
    id: "od:template:mobile-app",
    kind: "template",
    name: "Mobile App Design",
    description:
      "Mobile app screen rendered inside a pixel-accurate iPhone 15 Pro frame using reusable screen archetypes.",
    source: source("design-templates/mobile-app"),
    targets: ["mobile-app-design"],
    tags: ["mobile", "app", "ios", "design", "prototype", "phone"],
    triggers: [
      "mobile app",
      "ios app",
      "android app",
      "phone screen",
      "app ui",
      "app mockup",
    ],
    bestFor: ["mobile UI mockups", "single-screen app design reviews"],
    compatibleWith: ["od:skill:design-brief", "od:design-system:apple"],
    status: "curated",
    priority: 38,
  },
  {
    id: "od:template:html-ppt-graphify-dark-graph",
    kind: "template",
    name: "Graphify Dark Graph",
    description:
      "Dark knowledge-graph deck with midnight gradients, force-graph cover visuals, command-line highlights, and glass-morphism cards.",
    source: source("design-templates/html-ppt-graphify-dark-graph"),
    targets: ["presentation", "report"],
    tags: ["presentation", "dark", "graph", "data", "technical", "metrics"],
    triggers: ["deck", "presentation", "graph", "dark", "data story"],
    bestFor: ["data presentations", "technical executive briefings"],
    compatibleWith: ["od:design-system:trading-terminal"],
    status: "curated",
    priority: 32,
  },
  {
    id: "od:template:html-ppt-zhangzara-retro-zine",
    kind: "template",
    name: "Zhangzara Retro Zine",
    description:
      "Retro editorial zine presentation template with expressive composition, tactile paper energy, and bold magazine-like rhythm.",
    source: source("design-templates/html-ppt-zhangzara-retro-zine"),
    targets: ["presentation", "poster", "report"],
    tags: ["presentation", "retro", "zine", "editorial", "expressive"],
    triggers: ["retro", "zine", "editorial", "magazine", "bold"],
    bestFor: [
      "editorial decks",
      "culture reports",
      "visually distinctive summaries",
    ],
    compatibleWith: [
      "od:skill:article-magazine",
      "od:design-system:warm-editorial",
    ],
    status: "curated",
    priority: 30,
  },
  {
    id: "od:template:weekly-update",
    kind: "template",
    name: "Weekly Update",
    description:
      "Single-file horizontal-swipe weekly team update deck for shipped work, in-flight work, blockers, metrics, and asks.",
    source: source("design-templates/weekly-update"),
    targets: ["presentation", "report", "docs-design"],
    tags: ["update", "status", "briefing", "report", "metrics"],
    triggers: ["weekly", "status", "update", "briefing"],
    bestFor: ["team updates", "status reports", "progress summaries"],
    compatibleWith: ["od:design-system:dashboard"],
    status: "curated",
    priority: 24,
  },
  {
    id: "od:template:web-prototype-taste-editorial",
    kind: "template",
    name: "Taste Editorial Web Prototype",
    description:
      "Editorial-minimalist web prototype with warm monochrome canvas, serif display type, hairline borders, pastel chips, and ambient micro-motion.",
    source: source("design-templates/web-prototype-taste-editorial"),
    targets: ["website", "poster"],
    tags: ["website", "editorial", "brand", "visual", "prototype"],
    triggers: ["landing", "site", "brand", "editorial", "launch"],
    bestFor: ["brand websites", "launch pages", "editorial product pages"],
    compatibleWith: ["od:skill:article-magazine", "od:design-system:editorial"],
    status: "curated",
    priority: 30,
  },
  ...Object.entries(ADDITIONAL_OPEN_DESIGN_TEMPLATE_DESCRIPTIONS).map(
    ([slug, description]) => {
      return createOpenDesignTemplateEntry(slug, description);
    },
  ),
  {
    id: "od:design-system:dashboard",
    kind: "design-system",
    name: "Dashboard",
    description:
      "Dark cloud-platform aesthetic with modular grids, glass-like panels, and strong data hierarchy for productivity dashboards.",
    source: source("design-systems/dashboard"),
    targets: ["website", "dashboard-design", "report"],
    tags: ["dashboard", "neutral", "dense", "table", "operations", "charts"],
    triggers: ["dashboard", "analytics", "metrics", "ops", "report"],
    bestFor: ["operational UIs", "data reports", "admin surfaces"],
    status: "curated",
    priority: 36,
  },
  {
    id: "od:design-system:trading-terminal",
    kind: "design-system",
    name: "Trading Terminal",
    description:
      "Bloomberg-style financial trading terminal: dark-only, data-dense, with cyan and coral buy/sell signals readable at a glance.",
    source: source("design-systems/trading-terminal"),
    targets: ["presentation", "website", "dashboard-design", "report"],
    tags: ["dark", "terminal", "finance", "data", "charts", "dense"],
    triggers: ["dark", "terminal", "trading", "chart", "graph"],
    bestFor: ["dark analytical reports", "graph-heavy dashboards"],
    status: "curated",
    priority: 32,
  },
  {
    id: "od:design-system:warm-editorial",
    kind: "design-system",
    name: "Warm Editorial",
    description:
      "Serif-led magazine aesthetic with terracotta accents on warm off-white paper for readable narrative pages, zines, and reports.",
    source: source("design-systems/warm-editorial"),
    targets: ["presentation", "website", "poster", "report", "docs-design"],
    tags: ["warm", "editorial", "magazine", "narrative", "readable"],
    triggers: ["editorial", "magazine", "zine", "warm", "story"],
    bestFor: ["narrative reports", "editorial decks", "long-form pages"],
    status: "curated",
    priority: 30,
  },
  {
    id: "od:design-system:editorial",
    kind: "design-system",
    name: "Editorial",
    description:
      "Magazine-inspired editorial layout with refined serif typography, structured grids, and elegant reading experiences.",
    source: source("design-systems/editorial"),
    targets: ["presentation", "website", "poster", "report", "docs-design"],
    tags: ["editorial", "typography", "media", "brand", "article"],
    triggers: ["editorial", "article", "brand", "landing", "magazine"],
    bestFor: ["brand sites", "article-style reports", "visual narratives"],
    status: "curated",
    priority: 28,
  },
  {
    id: "od:design-system:mono",
    kind: "design-system",
    name: "Mono",
    description:
      "Monospace-driven, matrix-inspired design with high-contrast elements, compact density, and a hacker-chic aesthetic.",
    source: source("design-systems/mono"),
    targets: ["website", "docs-design", "report"],
    tags: ["mono", "docs", "technical", "minimal", "structured"],
    triggers: ["docs", "technical", "reference", "minimal", "api"],
    bestFor: ["technical documentation", "implementation reports"],
    status: "curated",
    priority: 20,
  },
  {
    id: "od:design-system:apple",
    kind: "design-system",
    name: "Apple",
    description:
      "Consumer electronics design system with premium white space, SF Pro-style typography, and cinematic imagery.",
    source: source("design-systems/apple"),
    targets: ["mobile-app-design", "website"],
    tags: ["apple", "mobile", "ios", "clean", "product"],
    triggers: ["mobile", "ios", "iphone", "app design", "app ui"],
    bestFor: ["phone-framed product mocks", "consumer mobile UI"],
    status: "curated",
    priority: 34,
  },
  ...Object.entries(ADDITIONAL_OPEN_DESIGN_DESIGN_SYSTEM_DESCRIPTIONS).map(
    ([slug, description]) => {
      return createOpenDesignDesignSystemEntry(slug, description);
    },
  ),
  {
    id: "vm0:image-style:notion-illustration",
    kind: "image-style",
    name: "Notion Illustration",
    description:
      "Zero-native illustration style for hand-drawn product spot illustrations with simple ink contours and soft backgrounds.",
    desc: 'Notion-editorial-style hand-drawn spot illustration. Black brush-pen ink on white, tapered confident strokes, solid-black curly hair, solid-black pants/shoes, 3/4 face turned toward viewer with closed-eye smile and soft nose hint, open breathing body outlines, and 1-3 supporting scene props + ambient marks that frame the moment. Trigger when user says /notion-illustration, asks for a "Notion-style illustration", "Notion spot illustration", or a new piece in this hand-drawn brush-pen Notion editorial style.',
    source: sourceRef(
      VM0_SKILLS_REPO,
      VM0_SKILLS_REF,
      "illustration-template/notion-illustration",
    ),
    targets: ["image", "website", "poster", "presentation", "report"],
    tags: ["image", "illustration", "notion", "spot", "hand-drawn", "product"],
    triggers: [
      "illustration",
      "notion illustration",
      "spot illustration",
      "hand drawn",
      "product illustration",
    ],
    bestFor: [
      "in-app empty states",
      "gallery previews",
      "product narrative artwork",
    ],
    outputKinds: ["image"],
    primaryOutputKind: "image",
    executorHints: ["skill-authored", "built-in-image"],
    previewHint: "image",
    remixHint: "prompt-with-resource-hints",
    status: "experimental",
    priority: 18,
  },
  {
    id: "vm0:image-style:vm0-illustration",
    kind: "image-style",
    name: "vm0 Illustration",
    description:
      "vm0 in-app spot illustration style with bold hand-drawn ink line art, white-filled interiors, and a soft rounded color backdrop.",
    desc: "Generate vm0-style vm0 in-app spot illustrations: bold hand-drawn ink line art with white-filled interiors, a soft rounded color backdrop, transparent output, and simple iconic metaphors for product states.",
    source: sourceRef(
      VM0_SKILLS_REPO,
      VM0_SKILLS_REF,
      "illustration-template/vm0-illustration",
    ),
    targets: ["image", "website", "poster", "presentation", "report"],
    tags: [
      "image",
      "illustration",
      "spot",
      "in-app",
      "empty-state",
      "hand-drawn",
      "vm0",
    ],
    triggers: [
      "vm0 style",
      "in-app illustration",
      "empty state illustration",
      "vm0 illustration",
      "soft rounded color backdrop",
    ],
    bestFor: [
      "in-app empty states",
      "billing and permission illustrations",
      "small product state artwork",
    ],
    outputKinds: ["image"],
    primaryOutputKind: "image",
    executorHints: ["skill-authored", "built-in-image"],
    previewHint: "image",
    remixHint: "prompt-with-resource-hints",
    status: "experimental",
    priority: 19,
  },
];

export function listImageStyles(): readonly OpenDesignRegistryEntry[] {
  return OPEN_DESIGN_REGISTRY.filter((entry) => {
    return entry.kind === "image-style";
  });
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

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function tokenize(value: string): readonly string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/u)
    .filter((token) => {
      return token.length >= 2;
    });
}

function phraseScore(
  values: readonly string[] | undefined,
  prompt: string,
  weight: number,
): number {
  if (!values) {
    return 0;
  }

  return values.reduce((score, value) => {
    return prompt.includes(normalizeText(value)) ? score + weight : score;
  }, 0);
}

function tokenScore(
  values: readonly string[] | undefined,
  promptTokens: Set<string>,
  weight: number,
): number {
  if (!values) {
    return 0;
  }

  return values.reduce((score, value) => {
    const matches = tokenize(value).filter((token) => {
      return promptTokens.has(token);
    });
    return score + matches.length * weight;
  }, 0);
}

function scoreEntry(
  entry: OpenDesignRegistryEntry,
  target: OpenDesignTarget,
  prompt: string,
): number {
  const normalizedPrompt = normalizeText(prompt);
  const promptTokens = new Set(tokenize(prompt));
  const targetScore = entry.targets.includes(target) ? 100 : 0;

  return (
    targetScore +
    (entry.priority ?? 0) +
    phraseScore(entry.triggers, normalizedPrompt, 40) +
    phraseScore(entry.bestFor, normalizedPrompt, 15) +
    tokenScore(entry.tags, promptTokens, 10) +
    tokenScore(entry.description.split(" "), promptTokens, 2)
  );
}

function selectByKind(
  kind: OpenDesignResourceKind,
  target: OpenDesignTarget,
  prompt: string,
  limit: number,
): readonly OpenDesignRegistryEntry[] {
  return OPEN_DESIGN_REGISTRY.filter((entry) => {
    return entry.kind === kind;
  })
    .map((entry) => {
      return { entry, score: scoreEntry(entry, target, prompt) };
    })
    .filter(({ score }) => {
      return score > 0;
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.entry.id.localeCompare(right.entry.id);
    })
    .slice(0, limit)
    .map(({ entry }) => {
      return entry;
    });
}

export function selectOpenDesignCandidates(options: {
  readonly target: OpenDesignTarget;
  readonly prompt: string;
  readonly limitPerKind?: number;
}): OpenDesignCandidateSlice {
  const limitPerKind = options.limitPerKind ?? 8;

  return {
    registryVersion: OPEN_DESIGN_REGISTRY_VERSION,
    source: {
      repo: OPEN_DESIGN_REPO,
      commit: OPEN_DESIGN_COMMIT,
    },
    sources: [
      {
        repo: OPEN_DESIGN_REPO,
        commit: OPEN_DESIGN_COMMIT,
      },
      {
        repo: VM0_SKILLS_REPO,
        commit: VM0_SKILLS_REF,
      },
    ],
    candidates: {
      skills: selectByKind(
        "skill",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      templates: selectByKind(
        "template",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      designSystems: selectByKind(
        "design-system",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      imageStyles: selectByKind(
        "image-style",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      audioStyles: selectByKind(
        "audio-style",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      videoTemplates: selectByKind(
        "video-template",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      bundleTemplates: selectByKind(
        "bundle-template",
        options.target,
        options.prompt,
        limitPerKind,
      ),
    },
  };
}
