// ---------------------------------------------------------------------------
// Models. Built-in lineup shown on /models and /models/[slug].
//
// Order, multipliers, pricing, and routing facts mirror the platform:
//   - turbo/packages/api-contracts/src/contracts/model-providers.ts
//     (VM0_MODEL_TO_PROVIDER, MODEL_PROVIDER_TYPES)
//   - turbo/apps/platform/.../settings/provider-ui-config.ts
//     (VM0_MODEL_CREDIT_MULTIPLIER)
//   - turbo/apps/web/scripts/dev-seed.ts (MODEL_PRICING. USD per 1M tokens)
//
// Benchmark scores are vendor-reported public numbers; cite carefully.
// ---------------------------------------------------------------------------

const VENDOR_ICONS: Readonly<Record<string, string>> = {
  Anthropic: "/assets/connectors/anthropic.svg",
  "Z.AI": "/assets/connectors/chatglm.svg",
  Moonshot: "/assets/connectors/kimi.svg",
  DeepSeek: "/assets/connectors/deepseek.svg",
  MiniMax: "/assets/connectors/minimax.svg",
};

export function vendorIconPath(vendor: string): string | null {
  return VENDOR_ICONS[vendor] ?? null;
}

export interface ModelPricing {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  /** `null` when the upstream provider does not bill cache writes. */
  cacheWriteUsd: number | null;
}

export interface SpecRow {
  label: string;
  value: string;
}

export interface PerformanceNote {
  title: string;
  body: string;
}

export interface BenchmarkScore {
  /** Benchmark name (e.g. "SWE-bench Verified"). */
  name: string;
  /** Score string (e.g. "80.6%", "53"). */
  score: string;
  /** Optional context (e.g. "vendor-reported"). */
  note?: string;
}

export interface BestForExample {
  title: string;
  body: string;
}

export interface ModelComparison {
  vs: string;
  body: string;
}

export interface ModelFaq {
  q: string;
  a: string;
}

export interface ModelEntry {
  slug: string;
  modelId: string;
  name: string;
  vendor: string;
  multiplier: number;

  // SEO
  /** ≤ 60-char meta <title>. Lead with the model name + topical keywords. */
  metaTitle: string;
  /** ≤ 160-char meta description. */
  metaDescription: string;
  /** H1 on the detail page. */
  pageTitle: string;
  /** Sub-headline / tagline shown under the H1. 1 to 2 sentences. */
  tagline: string;

  // Hero quick facts
  contextWindowK: number;
  promptCaching: boolean;
  modalities: string[];
  releasedToVm0: string;

  // List page
  cardIntro: string;

  // TL;DR
  summary: string;

  // Overview / release
  /** Vendor release date. e.g. "April 20, 2026" or "February 2026". */
  releaseDate: string;
  /** Where the model sits in its family. For SEO scanability. */
  familyPosition: string;
  /** 1 to 3 paragraphs about the model itself (vendor-neutral). */
  background: string[];

  // Architecture / what's new
  /** Single prose paragraph covering headline architecture and capabilities. Empty string when there's nothing notable to add. */
  architecture: string;

  // Specs
  specs: SpecRow[];

  // Benchmarks
  /** Vendor-reported public benchmark scores. */
  benchmarks: BenchmarkScore[];
  /** 1-paragraph context for the benchmark table. */
  benchmarksNote: string;

  // Pricing
  pricing: ModelPricing;

  // Performance
  performance: PerformanceNote[];

  // VM0 routing
  routingNotes: string;
  /** Extra VM0-specific routing context as a single prose paragraph. Empty string when there's nothing extra to say. */
  vm0Notes: string;
  vm0TimeoutMin?: number;
  /**
   * VM0 positioning for this model:
   * - "core" — recommended for primary agent tasks (Opus, Sonnet, DeepSeek V4 Pro).
   * - "cost-saving" — used to optimise cost on non-core work, not the recommended default.
   */
  vm0Tier: "core" | "cost-saving";
  /** What the upstream vendor calls the API key path on VM0. e.g. "Anthropic API key". */
  byoKeyLabel: string;

  // Best for
  bestForExamples: BestForExample[];
  /** Single paragraph describing when to skip this model. */
  avoidFor: string;

  // Comparisons
  comparisons: ModelComparison[];

  // Verdict / bottom line
  verdict: string;

  // FAQ
  faqs: ModelFaq[];

  // Alternatives card row
  alternatives: { slug: string; reason: string }[];

  /** Provider configurations that default to this model. */
  defaultFor: string[];
}

const ANTHROPIC_SPECS_COMMON: SpecRow[] = [
  { label: "Family", value: "Claude 4 generation" },
  { label: "Modalities", value: "Text, vision, code" },
  { label: "Languages", value: "English-first, multilingual" },
  { label: "Prompt caching", value: "Supported (Anthropic)" },
];

export const MODELS: ModelEntry[] = [
  // -------------------------------------------------------------------------
  {
    slug: "claude-opus-4-7",
    modelId: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    vendor: "Anthropic",
    multiplier: 1.7,

    metaTitle: "Claude Opus 4.7: Benchmarks, Pricing & Capabilities",
    metaDescription:
      "Claude Opus 4.7 review. Anthropic's flagship Claude 4 model with 1M-token context, adaptive thinking, $5/$25 vendor pricing, and benchmark gains over Opus 4.6 on SWE-bench, Terminal-Bench, OSWorld, ARC AGI 2, and GPQA Diamond.",
    pageTitle: "Claude Opus 4.7",
    tagline:
      "Anthropic's flagship Claude 4 model. The strongest pick in the family for long-horizon agent loops, hard reasoning, and first-attempt code edits.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "April 17, 2026",

    cardIntro:
      "Anthropic's flagship Claude 4 model. Highest reasoning quality in the family on multi-step agent loops, long-context recall, and code edits.",

    summary:
      "Claude Opus 4.7 is the model you reach for when the work has to be right the first time: code that compiles cleanly, multi-step plans that don't lose the thread across long tool chains, abstract puzzles smaller models stumble on. Vendor benchmarks (SWE-bench Verified, Terminal-Bench 2.0, ARC AGI 2, OSWorld, BrowseComp) put concrete numbers on the gains over Opus 4.6.\n\nVendor list price is $5 / $25 per 1M tokens with cached input at $0.50 / 1M, the highest in the Claude family. The cost-effective pattern is to keep Sonnet 4.6 as the default and route only the hardest steps to Opus.",

    releaseDate: "April 2026 (succeeding Opus 4.6)",
    familyPosition:
      "Top-tier of the Claude 4 family. Anthropic's recommended upgrade for users on Opus 4.6.",
    background: [
      "Claude Opus 4.7 is the flagship of Anthropic's Claude 4 family, released in April 2026 as the recommended upgrade from Opus 4.6. Anthropic frames it as a step-change improvement on agentic coding and abstract reasoning rather than a refresh on the surface API. The 1M-token context window and adaptive-thinking effort levels introduced in 4.6 carry over unchanged, so existing agent code drops in without rewrites.",
      "Compared to Sonnet 4.6 (the workhorse in the same family), Opus invests more compute per token. The behavioural payoff shows up in three places: fewer dropped instructions on long agent loops, materially better first-attempt code patches, and stronger recall once the conversation history grows past 100K tokens. The trade-off is the highest list price in the Claude family ($5 / $25 per 1M tokens) and slower per-token output speed, which is why Anthropic itself positions Opus as the orchestrator or escalation tier rather than the everywhere-default.",
      "Independent leaderboards (Artificial Analysis, Vellum) corroborate the relative ordering against Opus 4.6, but absolute numbers shift weekly and OpenAI has flagged training-data contamination on SWE-bench Verified across all frontier models. Treat the public scores as directional rather than authoritative; the structured behavioural differences (long-loop coherence, first-attempt patch quality, multi-tool routing reliability) are the more durable signal.",
    ],

    architecture:
      "Opus 4.7 keeps the 1M-token context window from Opus 4.6, billed at standard input pricing across the entire window. It supports adaptive thinking at four effort levels (low, medium, high, and max), a Compaction API for server-side context summarisation on long runs, and prompt caching where cached input bills at one-tenth the input rate. Multi-agent and tool-use surfaces are unchanged from 4.6, including the Mailbox Protocol for peer-to-peer agent teams and the `inference_geo` parameter that exposes US-only inference at a 1.1× multiplier. Inputs are multimodal across text, vision, and code.",

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "1M tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Effort levels", value: "Low / Medium / High / Max" },
      { label: "Vendor list price", value: "$5 input / $25 output per 1M" },
    ],

    benchmarks: [
      {
        name: "SWE-bench Verified",
        score: "~83.5%",
        note: "vendor-reported; up from Opus 4.6's 80.8%",
      },
      {
        name: "SWE-bench Pro",
        score: "Leads Claude family at release",
        note: "vendor-reported",
      },
      {
        name: "Terminal-Bench 2.0",
        score: "~71%",
        note: "vendor-reported; up from Opus 4.6's 65.4%",
      },
      {
        name: "τ2-bench Retail",
        score: "~93%",
        note: "vendor-reported tool-use",
      },
      {
        name: "OSWorld (computer use)",
        score: "~76%",
        note: "vendor-reported; up from Opus 4.6's 72.7%",
      },
      { name: "BrowseComp", score: "~88%", note: "vendor-reported web tasks" },
      {
        name: "ARC AGI 2",
        score: "~75%",
        note: "vendor-reported; up from Opus 4.6's 68.8%",
      },
      {
        name: "Humanity's Last Exam (with tools)",
        score: "Leads Claude family",
        note: "vendor-reported",
      },
      {
        name: "GPQA Diamond",
        score: "~92%",
        note: "vendor-reported graduate-level science",
      },
      {
        name: "MRCR v2 (1M, 8-needle)",
        score: "Improved over 4.6's 76%",
        note: "long-context recall",
      },
      {
        name: "MMMU Pro (multimodal)",
        score: "Leads Claude family",
        note: "vendor-reported",
      },
    ],
    benchmarksNote:
      "Vendor-reported scores from Anthropic's Opus 4.7 release materials, with deltas shown against the public Opus 4.6 numbers. Independent reviews place 4.7 ahead of GPT-5.2 on most agentic-coding tasks and within a few points of Gemini 3 Pro on abstract reasoning. Treat absolute percentages as directional; OpenAI has flagged training-data contamination on SWE-bench Verified across all frontier models.",

    pricing: {
      inputUsd: 5,
      outputUsd: 25,
      cacheReadUsd: 0.5,
      cacheWriteUsd: 6.25,
    },

    performance: [
      {
        title: "Tool routing",
        body: "Lowest rate of mis-routed tool calls in the Claude family. The gap versus Sonnet 4.6 widens on hard edge cases such as conditional tool selection, deeply nested arguments, and tool calls dispatched after long stretches of reasoning.",
      },
      {
        title: "Long-context recall",
        body: "Coherent across 200K+ token agent transcripts. The 1M-token window holds up far better than predecessors thanks to the context-rot improvements Anthropic introduced in Opus 4.6 and refined further for 4.7. Vendor-reported MRCR v2 at 1M shows a measurable lift over Opus 4.6's 76%.",
      },
      {
        title: "First-attempt code edits",
        body: "Strongest patch quality in the Claude family. The right pick when an agent has to modify code that must keep compiling and passing tests, especially when the patch spans multiple files. Anthropic's Terminal-Bench 2.0 result reflects this directly.",
      },
      {
        title: "Speed",
        body: "Slower than Sonnet 4.6 and noticeably slower than Haiku 4.5. Anthropic publishes ~41 tokens/sec at max effort for Opus 4.6, and 4.7 is in a similar range. Reserve it for the steps that actually need the extra reasoning depth and run lighter tiers in parallel.",
      },
      {
        title: "Hallucination behaviour",
        body: "Opus 4.7 retains Anthropic's conservative refusal posture and tends to admit uncertainty rather than confabulate, which is the reason production teams keep paying the premium for high-stakes reasoning despite cheaper open-weight alternatives like Kimi K2.6 and DeepSeek V4 Pro now matching it on benchmarks.",
      },
    ],

    routingNotes:
      "On VM0, Opus 4.7 is routed directly to Anthropic's Messages API and is exposed three ways: through the VM0 Managed credit pool, through a direct Anthropic API key, and through the Claude Code OAuth provider for teams already authenticated with Claude Code.",
    vm0Notes:
      "Prompt caching is enabled by default through VM0, which substantially cuts the cost of repeated system prompts, tool definitions, and pasted reference documents on agents that issue many turns from the same prefix. There are no VM0-side timeout overrides for Opus 4.7; the model uses Anthropic's default API timeouts. Sonnet 4.6 stays the platform default for new agents, so the standard pattern is to keep cheap tiers running everywhere and route only the hardest steps to Opus 4.7.",
    vm0Tier: "core",
    byoKeyLabel: "Anthropic API key",

    bestForExamples: [
      {
        title: "The PR review that catches what humans miss",
        body: "When a pull request changes 30 files, Opus 4.7 keeps the entire change in working memory and writes a review that ties what changed in `auth/middleware.ts` to the test it broke in `routes/admin.test.ts`. Junior reviewers get the kind of cross-file feedback that senior engineers usually catch on a second pass, and the team ships fewer patches that pass CI but break in production.",
      },
      {
        title: "The research run that reads the whole pile",
        body: "Drop a 200-page contract draft, three competitor proposals, and last quarter's legal opinions into the 1M-token context window, then ask Opus to flag every clause that's tighter than market and list the likely negotiation points. Smaller models start dropping earlier sections after 100K tokens; Opus keeps the whole picture in view and references the exact paragraph it's quoting.",
      },
      {
        title: "The orchestrator running a multi-tool plan",
        body: "Use Opus 4.7 as the planner that breaks a customer's request into ten steps, dispatches each step to a Sonnet- or Haiku-tier sub-agent, and stitches the results back together. Running Opus only at the planner layer (and the cheaper tiers everywhere else) costs a fraction of running Opus end-to-end, with most of the quality preserved.",
      },
      {
        title: "The first-try code edits that don't waste a CI run",
        body: "Ask Opus 4.7 to migrate a 50-file codebase from one ORM to another, refactor a tangled module, or apply a security fix across the repo. The patch applies cleanly on the first attempt more often than any other model in the family, which is what vendor-reported Terminal-Bench 2.0 reflects, and what your CI bill will reflect too.",
      },
    ],
    avoidFor:
      "Skip Opus 4.7 on high-volume routine work where Sonnet 4.6 hits the same quality bar at a fraction of the cost, on latency-sensitive chat replies where Haiku 4.5 is much faster, and on bulk classification or extraction jobs where DeepSeek V4 Flash is roughly 80× cheaper at the vendor level.",

    comparisons: [
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 is the workhorse default in the Claude family and the right pick for most agents. Promote to Opus 4.7 only when Sonnet visibly fails on hard reasoning, long context, or first-attempt code edits, usually as the orchestrator that delegates downward to Sonnet- or Haiku-tier sub-agents.",
      },
      {
        vs: "Claude Opus 4.6",
        body: "Same context window (1M tokens), same vendor pricing, and the same adaptive-thinking architecture. Opus 4.7 is the newer generation with vendor-reported gains across SWE-bench Verified, Terminal-Bench 2.0, ARC AGI 2, and OSWorld. Pick 4.7 for new agents; pin 4.6 only when an existing agent has been validated against that version and you need behaviour stability.",
      },
      {
        vs: "Kimi K2.6",
        body: "Moonshot's Kimi K2.6 leads several agentic benchmarks at the open-source frontier (vendor-reported SWE-bench Pro 58.6 versus Opus 4.6's 53.4). Opus 4.7 retains the lead on tool-routing reliability for production English-language agents and on safety profile, which is why most enterprise teams still keep it as the high-stakes tier.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro trails Opus on most reasoning benchmarks but matches it on coding (vendor-reported SWE-bench Verified within ~0.2 points). The split is straightforward: pick DeepSeek when raw cost dominates, pick Opus 4.7 when reliability, safety profile, or tool-routing accuracy matter more than per-call price.",
      },
      {
        vs: "GPT-5.2 / Gemini 3 Pro",
        body: "Anthropic's vendor materials position Opus 4.7 ahead of GPT-5.2 on most agentic-coding tasks (Terminal-Bench, τ2-bench Retail) and within a few points of Gemini 3 Pro on abstract reasoning (ARC AGI 2, GPQA Diamond). Independent leaderboards corroborate the rough ordering but shift weekly.",
      },
    ],

    verdict:
      "Opus 4.7 is the escalation tier. Default to Sonnet 4.6; promote to Opus only on the specific steps where Sonnet visibly fails.",

    faqs: [
      {
        q: "What is Claude Opus 4.7's context window?",
        a: "1 million tokens, with up to 64K tokens of output per response. The full window bills at standard rates. A 900K-token request is the same per-token rate as a 9K-token request.",
      },
      {
        q: "Can Claude Opus 4.7 handle images?",
        a: "Yes. Opus 4.7 is multimodal. It accepts image inputs alongside text and code, so screenshot-driven and document-vision agents work natively.",
      },
      {
        q: "When should I pick Opus 4.7 over Sonnet 4.6?",
        a: "When (a) the agent is the planner / orchestrator and decisions cascade, (b) the run is long enough that Sonnet starts dropping instructions, or (c) the output must apply cleanly on the first attempt (code edits, structured payloads).",
      },
      {
        q: "Should I migrate from Opus 4.6 to Opus 4.7?",
        a: "Yes. Anthropic explicitly recommends 4.7 over 4.6. Same multiplier, stronger behaviour. Migrate pinned production agents only after running them through your regression suite.",
      },
      {
        q: "Does Opus 4.7 support prompt caching?",
        a: "Yes. Cached input bills at $0.50 per 1M tokens. A 10× discount on the cached portion. Worth using whenever your system prompt or tool schema is stable across calls.",
      },
    ],

    alternatives: [
      {
        slug: "claude-sonnet-4-6",
        reason: "Cheaper default for most agent loops",
      },
      {
        slug: "kimi-k2.6",
        reason: "Stronger long-context recall at lower cost",
      },
      {
        slug: "deepseek-v4-pro",
        reason: "Cost-optimised reasoning if Claude is overkill",
      },
    ],
    defaultFor: [],
  },

  // -------------------------------------------------------------------------
  {
    slug: "claude-opus-4-6",
    modelId: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    vendor: "Anthropic",
    multiplier: 1.7,

    metaTitle: "Claude Opus 4.6 on VM0: Benchmarks, Pricing & Migration",
    metaDescription:
      "Claude Opus 4.6 review on VM0. Anthropic's previous flagship. SWE-bench Verified 80.8%, $5/$25 pricing, 1M context, and when to pin 4.6 instead of upgrading.",
    pageTitle: "Claude Opus 4.6 on VM0",
    tagline:
      "Anthropic's previous flagship. Same multiplier and 1M context as Opus 4.7. Keep it pinned only when an agent has been validated on this exact version.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "Available since launch",

    cardIntro:
      "Anthropic's previous flagship. Same credit cost as Opus 4.7. Keep it pinned only if a specific agent has been validated against this version.",

    summary:
      "Claude Opus 4.6 was Anthropic's flagship before Opus 4.7 and introduced most of what now defines the Claude 4 family: the 1M-token context window in beta, adaptive thinking at four effort levels, and the highest agentic-coding scores Anthropic had shipped at the time (vendor-reported SWE-bench Verified 80.8%, Terminal-Bench 2.0 65.4%, OSWorld 72.7%).\n\nVendor list price is the same $5 / $25 per 1M tokens as 4.7. The only good reason to stay on 4.6 is behaviour stability for an agent that's already been validated against this version; anything new should start on 4.7.",

    releaseDate: "February 5, 2026",
    familyPosition:
      "Previous top-tier of the Claude 4 family. Superseded by Claude Opus 4.7.",
    background: [
      "Claude Opus 4.6 was Anthropic's frontier model before Opus 4.7. It was released on February 5, 2026 and introduced several capabilities that defined the Claude 4 family. Adaptive thinking with four effort levels, the 1M-token context window in beta, and Anthropic's highest agentic-coding scores at release.",
      "On VM0 it sits at the same ×1.7 credit multiplier as Opus 4.7. Anthropic explicitly recommends migrating to 4.7 for new work; pin 4.6 only if a specific agent has been validated against this version and you don't want to re-run regression tests yet.",
    ],

    architecture:
      "Opus 4.6 introduced adaptive thinking with four effort levels (low, medium, high, and max, with high as the default) and the 1M-token context window in beta at standard pricing. It added a Compaction API for server-side context summarisation, disabled prefilling as a breaking change versus Opus 4.5 (use structured outputs instead), and shipped a Mailbox Protocol for multi-agent peer-to-peer teams. An `inference_geo` parameter exposes US-only inference at a 1.1× multiplier.",

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "1M tokens (beta)" },
      { label: "Max output", value: "Up to 128K tokens" },
      { label: "Available on VM0", value: "Available since launch" },
    ],

    benchmarks: [
      { name: "SWE-bench Verified", score: "80.8%", note: "vendor-reported" },
      { name: "Terminal-Bench 2.0", score: "65.4%", note: "vendor-reported" },
      {
        name: "OSWorld (computer use)",
        score: "72.7%",
        note: "vendor-reported",
      },
      { name: "MRCR v2 (1M, 8-needle)", score: "76%", note: "vendor-reported" },
      {
        name: "Artificial Analysis Intelligence Index",
        score: "53",
        note: "max effort",
      },
      { name: "Speed", score: "~41 tokens/sec", note: "Artificial Analysis" },
    ],
    benchmarksNote:
      "Vendor-reported scores from Anthropic's Opus 4.6 release materials and Artificial Analysis. Treat absolute SWE-bench numbers cautiously. OpenAI flagged training-data contamination on SWE-bench Verified across all frontier models.",

    pricing: {
      inputUsd: 15,
      outputUsd: 75,
      cacheReadUsd: 1.5,
      cacheWriteUsd: 18.75,
    },

    performance: [
      {
        title: "Reasoning",
        body: "Strong on hard reasoning steps. Opus 4.7 is incrementally better at slightly lower vendor cost. There is no benchmark category where 4.6 leads.",
      },
      {
        title: "Tool use",
        body: "Reliable across multi-tool agent flows. Same ballpark as Sonnet 4.6 on routing accuracy with extra robustness on edge cases.",
      },
      {
        title: "Long context",
        body: "1M-token context with 76% MRCR v2 recall. Actually usable across the full window, not just nominal.",
      },
      {
        title: "Speed",
        body: "Slower than Sonnet 4.6 and Haiku 4.5; comparable to Opus 4.7. Around 41 tokens/sec at max effort per Artificial Analysis.",
      },
    ],

    routingNotes:
      "Routed directly to Anthropic's Messages API. Available on VM0 Managed and as the default model on the Anthropic API-key and Claude Code OAuth providers.",
    vm0Notes:
      "Opus 4.6 carries the highest vendor list price per token of any Built-in model, so prompt caching matters here more than anywhere else and is on by default. It's still the default model on the Anthropic API-key and Claude Code OAuth providers, which means it's likely the model your team already has muscle memory for, even though Opus 4.7 is the recommended choice for new work.",
    vm0Tier: "core",
    byoKeyLabel: "Anthropic API key",

    bestForExamples: [
      {
        title: "The production agent that's already paying its way",
        body: "Your team spent two weeks tuning prompts and tool schemas against Opus 4.6, the agent has been live for a month, and customers are happy. Pinning to 4.6 keeps the behaviour identical while you decide whether the 4.7 upgrade is worth a re-validation cycle, instead of letting Anthropic auto-upgrade your traffic and quietly shifting outputs underneath you.",
      },
      {
        title: "The regression baseline for an Opus 4.7 rollout",
        body: "Run the same prompt set through 4.6 and 4.7 side by side, diff the outputs, and decide where the upgrade actually changes behaviour before you flip the switch in production. Same vendor price, same multiplier, identical interface — the only thing different is the model weights, which is exactly what you want when you're isolating regressions.",
      },
    ],
    avoidFor:
      "Don't start new agents on Opus 4.6 unless you have a concrete reason, since 4.7 ships at the same multiplier with stronger behaviour and a lower vendor list price. Anything cost-sensitive should go to 4.7 for the same reason.",

    comparisons: [
      {
        vs: "Claude Opus 4.7",
        body: "Same ×1.7 multiplier and 1M context window. Opus 4.7 is newer, faster, and lower vendor list price. Pin 4.6 only when you've already invested in tuning against this version.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 is ×1 and handles most agent loops. Reach for Opus only when Sonnet visibly fails. Usually for orchestration or hard code edits.",
      },
      {
        vs: "Kimi K2.6",
        body: "Kimi K2.6 (×0.3) edges Opus 4.6 on SWE-bench Pro (58.6 vs 53.4 vendor-reported) and is much cheaper. Opus 4.6 retains the safety-profile advantage and is the default Western enterprise pick.",
      },
    ],

    verdict:
      "Pin if you've already validated against it; otherwise start on Opus 4.7. The migration is a setting change, not a rewrite.",

    faqs: [
      {
        q: "When was Claude Opus 4.6 released?",
        a: "Anthropic released Opus 4.6 on February 5, 2026. Opus 4.7 followed shortly after.",
      },
      {
        q: "Should I migrate from Opus 4.6 to Opus 4.7?",
        a: "Yes for new work. Same multiplier, same 1M context, lower vendor list price, stronger behaviour on agentic-coding tasks. Migrate pinned agents only after running them through your regression suite.",
      },
      {
        q: "What is Claude Opus 4.6's context window?",
        a: "1 million tokens (beta) with up to 128K tokens of output per response.",
      },
      {
        q: "Why is Opus 4.6 the default on the Anthropic API key provider?",
        a: "Historical default from before Opus 4.7 launched. You can switch any agent to Opus 4.7, Sonnet 4.6, or Haiku 4.5 in VM0 Settings → Model Providers without changing the API key.",
      },
      {
        q: "What's adaptive thinking?",
        a: "A scheduling layer that lets Claude decide how much reasoning compute to spend per turn. Four levels. Low, medium, high, max. With high as the default. Replaced Opus 4.5's extended-thinking toggle.",
      },
    ],

    alternatives: [
      { slug: "claude-opus-4-7", reason: "Newer, lower vendor cost" },
      {
        slug: "claude-sonnet-4-6",
        reason: "Sonnet baseline at much lower cost",
      },
      {
        slug: "kimi-k2.6",
        reason: "Cheaper open-weight alternative on agentic benchmarks",
      },
    ],
    defaultFor: ["Anthropic API key", "Claude Code OAuth"],
  },

  // -------------------------------------------------------------------------
  {
    slug: "claude-sonnet-4-6",
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    vendor: "Anthropic",
    multiplier: 1,

    metaTitle: "Claude Sonnet 4.6 on VM0: Benchmarks, Pricing & Use Cases",
    metaDescription:
      "Claude Sonnet 4.6 is the default model on VM0. ×1 credit baseline, 1M context, $3/$15 pricing, SWE-bench Verified 77%. The agent tasks it handles best.",
    pageTitle: "Claude Sonnet 4.6 on VM0. The default agent model",
    tagline:
      "The default for most VM0 agents. Strong tool routing, good long-context behaviour, and the credit baseline. Every other model is priced relative to Sonnet 4.6.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "Available since launch",

    cardIntro:
      "The default for most VM0 agents. Strong tool-routing accuracy, good long-context behaviour, and the credit baseline. Every other model is priced relative to Sonnet 4.6.",

    summary:
      "Claude Sonnet 4.6 is the workhorse of the Claude 4 family and the default Built-in model on VM0. It picks the right tool with the right arguments more reliably than anything cheaper, stays coherent across hundred-thousand-token conversations, and most production agents — Slack triage, GitHub PR review, customer support — never need to be promoted past it.\n\nVendor list price is $3 / $15 per 1M tokens, with cached input dropping to $0.30 / 1M. Reach for Opus only when Sonnet visibly fails on the hardest reasoning, and for Haiku or DeepSeek V4 Flash when unit cost dominates.",

    releaseDate: "February 2026 (Claude 4.6 generation)",
    familyPosition:
      "Mid-tier of the Claude 4 family. Anthropic's workhorse model, sitting between Haiku and Opus.",
    background: [
      "Claude Sonnet 4.6 sits in the middle of Anthropic's Claude 4 family. It is the workhorse model designed to handle the full breadth of typical agent work. Multi-tool routing, code edits, long-running conversations, and structured-output tasks. Without the cost premium of Opus.",
      "Across VM0's Built-in lineup, every other model's credit multiplier is normalised against Sonnet 4.6 (×1). That makes Sonnet the right pick when you want predictable budget conversations: “this agent runs at roughly 2× a Sonnet step” is a more useful sentence than absolute dollar quotes that move every quarter.",
      "Sonnet 4.6 supports Anthropic's prompt caching, which makes a big difference for VM0 agents that ship a stable system prompt and a fixed tool schema. Cached input tokens bill at $0.30 per 1M instead of $3. A 10× saving on the parts of the prompt that don't change between turns.",
    ],

    architecture:
      "Sonnet 4.6 ships with the 1M-token context window at standard pricing, adaptive thinking inherited from Opus 4.6, and prompt caching that bills cached input at one-tenth the input rate. It accepts multimodal input across text, vision, and code.",

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "1M tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Default for", value: "VM0 Managed" },
    ],

    benchmarks: [
      { name: "SWE-bench Verified", score: "~77%", note: "vendor-reported" },
      {
        name: "Long-context recall",
        score: "Strong across 100K+",
        note: "internal observation",
      },
      {
        name: "Tool routing",
        score: "Best in class at ×1",
        note: "VM0 internal",
      },
    ],
    benchmarksNote:
      "Sonnet 4.6 sits roughly 3 to 4 percentage points behind Opus 4.6 on Anthropic's headline coding benchmarks while being three to five times cheaper at the vendor level. The typical Opus/Sonnet trade-off.",

    pricing: {
      inputUsd: 3,
      outputUsd: 15,
      cacheReadUsd: 0.3,
      cacheWriteUsd: 3.75,
    },

    performance: [
      {
        title: "Tool routing",
        body: "Best-in-class tool-routing accuracy at this price. On multi-tool flows across Slack, GitHub, Linear, and Notion, Sonnet 4.6 picks the correct tool with the correct arguments more reliably than any model below ×1.7.",
      },
      {
        title: "Long-context coherence",
        body: "Coherent across 100K+ token transcripts. Drops below Opus 4.7 only on the longest, most adversarial runs.",
      },
      {
        title: "Speed",
        body: "Faster than Opus and slower than Haiku. The right speed/quality balance for production agents.",
      },
      {
        title: "Cost predictability",
        body: "Pricing is the credit baseline; prompt caching makes the on-VM0 cost especially predictable for agents with fixed system prompts.",
      },
    ],

    routingNotes:
      "Routed directly to Anthropic's Messages API. Default model on VM0 Managed.",
    vm0Notes:
      "Sonnet 4.6 is the credit baseline (×1) that every other Built-in model's multiplier is normalised against, which is the main reason it stays the first choice for new agents on VM0; escalate to Opus only when Sonnet visibly underperforms on a specific task. Native prompt caching pairs well with VM0's stable system prompts and tool definitions, and keeps the per-turn cost of long-running agents predictable.",
    vm0Tier: "core",
    byoKeyLabel: "Anthropic API key",

    bestForExamples: [
      {
        title: "The Slack agent that knows where things live",
        body: "Triages incoming questions, follows up on stalled threads, posts status updates, and answers search-style queries (\"who's owning the auth refactor?\"). Sonnet's tool-routing accuracy means the right tool gets called with the right arguments on the first try, even when the request is ambiguous, so the agent feels reliable instead of flaky.",
      },
      {
        title: "The PR review agent that doesn't drown in noise",
        body: "Sonnet handles the bulk of code-aware work — PR review, test scaffolding, refactor suggestions, bug bisection — without leaving stylistic comments that nobody asked for. The 1M-token context window lets it pull in the related files and prior reviews when it matters, and you only escalate to Opus 4.7 for the patches Sonnet visibly struggles with.",
      },
      {
        title: "The research agent that makes 20 tool calls in a row",
        body: 'GitHub plus Linear plus Notion plus the web, stitched together across twenty-plus tool turns to answer a question like "why did this customer churn last quarter?" Sonnet keeps the goal in view across the whole chain at a fraction of Opus\'s cost, which is what makes it sustainable for everyday research as opposed to one-off deep dives.',
      },
      {
        title: "The customer-support assistant with a stable system prompt",
        body: "Long conversation histories, frequent tool calls into the CRM, the same hefty system prompt and tool schema on every turn. Sonnet's prompt caching turns that fixed prefix into a fraction of the input cost after the first call, which is what keeps per-conversation cost flat as volume grows.",
      },
    ],
    avoidFor:
      "Skip Sonnet 4.6 on the hardest reasoning steps where it visibly drops instructions and you should escalate to Opus 4.7, on bulk classification at high volume where DeepSeek V4 Flash is roughly 50× cheaper, and on latency-critical micro-replies where Haiku 4.5 is meaningfully faster.",

    comparisons: [
      {
        vs: "Claude Opus 4.7",
        body: "Sonnet 4.6 is ×1; Opus 4.7 is ×1.7. Sonnet handles most agents; Opus is the upgrade when reasoning depth matters more than throughput. Many teams use Opus as the planner and Sonnet as the worker.",
      },
      {
        vs: "Claude Haiku 4.5",
        body: "Haiku 4.5 is ×0.3. Three times cheaper than Sonnet. Sonnet leads on tool-routing accuracy and long-context coherence; Haiku wins on speed and cost. Use Haiku as a sub-agent or for high-volume simple flows.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro (×0.3) matches Sonnet on coding benchmarks (vendor-reported SWE-bench Verified) at much lower cost. The trade is some tool-routing reliability and a less-mature safety profile.",
      },
    ],

    verdict:
      "Start here. Migrate up to Opus 4.7 or down to Haiku 4.5 / DeepSeek V4 Pro once you've seen real production behaviour and know which direction makes sense.",

    faqs: [
      {
        q: "Why is Sonnet 4.6 the default model on VM0 Managed?",
        a: "It hits the best balance of reasoning quality, tool-routing accuracy, and cost in our lineup. New agents almost always work on Sonnet without further tuning.",
      },
      {
        q: "What is Claude Sonnet 4.6's context window?",
        a: "1 million tokens with up to 64K tokens of output per response.",
      },
      {
        q: "Does Sonnet 4.6 support image input?",
        a: "Yes. It's multimodal. Text, code, and images.",
      },
      {
        q: "When should I switch off Sonnet 4.6?",
        a: "Switch to Opus 4.7 if Sonnet visibly drops the goal on long agent loops or fails on hard code edits. Switch to Haiku 4.5 or DeepSeek V4 Flash for high-volume simple flows where cost dominates.",
      },
      {
        q: "Is Sonnet 4.6 the same as Sonnet 4.5?",
        a: "No. 4.6 is the newer generation in the Claude 4 family with better long-context behaviour and adaptive thinking. The vendor pricing per token is identical.",
      },
    ],

    alternatives: [
      {
        slug: "claude-opus-4-7",
        reason: "Use when Sonnet hits its reasoning ceiling",
      },
      {
        slug: "claude-haiku-4-5",
        reason: "Cheaper sibling for routing and triage",
      },
      {
        slug: "deepseek-v4-pro",
        reason: "Far cheaper alternative at similar reasoning quality",
      },
    ],
    defaultFor: ["VM0 Managed"],
  },

  // -------------------------------------------------------------------------
  {
    slug: "glm-5.1",
    modelId: "glm-5.1",
    name: "GLM-5.1",
    vendor: "Z.AI",
    multiplier: 0.4,

    metaTitle: "GLM-5.1 on VM0: 1M Context, Pricing & Best Agent Tasks",
    metaDescription:
      "GLM-5.1 review on VM0. Z.AI's flagship with up to 1M-token context, ×0.4 credit cost. Specs, pricing, performance and recommended agent tasks.",
    pageTitle: "GLM-5.1 on VM0. Long-context agents",
    tagline:
      "Z.AI's flagship. Up to a 1M-token context window. Strong for whole-codebase or whole-knowledge-base agents at well below Sonnet pricing.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    releasedToVm0: "April 2026",

    cardIntro:
      "Z.AI's flagship. Up to a 1M-token context window. Strong for whole-codebase or whole-knowledge-base agents at well below Sonnet pricing.",

    summary:
      "GLM-5.1 is the long-context specialist in the lineup, with up to 1M tokens of input. Reach for it when the prompt is genuinely huge: a whole repository at once, several hundred documents in a single research run. Independent leaderboards consistently rank it in the top tier of open-weight models for long-context work.\n\nVendor list price is $1.40 / $4.40 per 1M tokens, well under half of Sonnet 4.6 at the vendor level, and the API is Anthropic-compatible so Claude-style agents drop in without a rewrite. Reach for Sonnet or Opus when English reasoning depth matters more than context size, and for Haiku when latency dominates.",

    releaseDate: "Early 2026; full GA on VM0 April 2026",
    familyPosition: "Z.AI / Zhipu AI's flagship general-purpose model.",
    background: [
      "GLM-5.1 is the flagship of Zhipu AI's GLM series, distributed via Z.AI. It's a reasoning model with strong general capability and an unusually large context window. Up to 1M tokens, several times larger than the Anthropic and Moonshot defaults at the same price tier.",
      "On VM0, GLM-5.1 is exposed two ways: through VM0 Managed (routed via OpenRouter with the upstream id `z-ai/glm-5.1`), and via a direct Z.AI API key (where it's the default model). Either path uses Z.AI's Anthropic-compatible interface, so existing VM0 agents drop in unchanged.",
      "GLM-5.1 became broadly available on VM0 in April 2026 when its feature flag was retired (PR #10497). It's the cost-efficient long-context option in the lineup, sitting at ×0.4 credits. Less than half of Sonnet 4.6.",
    ],

    architecture:
      "GLM-5.1 exposes an up-to-1M-token context window (the largest in the Built-in lineup) through an Anthropic-compatible API surface, so Claude-style agents drop in unchanged. The upstream supports prompt caching at `api.z.ai`.",

    specs: [
      { label: "Family", value: "GLM-5 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Multilingual" },
      { label: "Context window", value: "Up to 1M tokens" },
      { label: "Prompt caching", value: "Supported (Anthropic-compatible)" },
      { label: "Available on VM0", value: "April 2026" },
    ],

    benchmarks: [
      {
        name: "Code Arena",
        score: "Top-3 (open weights)",
        note: "third-party leaderboard",
      },
      {
        name: "Long-context recall",
        score: "Strong across 1M-token window",
        note: "vendor-reported",
      },
    ],
    benchmarksNote:
      "Independent reviews place GLM-5.1 in the top tier of open-weight models for long-context tasks. Numbers shift weekly on third-party leaderboards. We deliberately don't pin exact percentages here.",

    pricing: {
      inputUsd: 1.4,
      outputUsd: 4.4,
      cacheReadUsd: 0.26,
      cacheWriteUsd: 1.4,
    },

    performance: [
      {
        title: "Long-context recall",
        body: "GLM-5.1's 1M-token window is genuinely usable. It maintains coherence well past the 200K boundary that limits the Anthropic family on the older 200K models. Useful for whole-repo or whole-doc-corpus agents.",
      },
      {
        title: "Reasoning",
        body: "Solid general reasoning. Below Sonnet 4.6 on the hardest English-language multi-tool routing, but the gap is small relative to the cost difference.",
      },
      {
        title: "Tool use",
        body: "Reliable across the common VM0 tool surface (Slack, GitHub, Notion, Linear). Some edge cases in deeply nested tool calls are handled less crisply than Claude Sonnet 4.6.",
      },
    ],

    routingNotes:
      "On VM0 Managed, GLM-5.1 is routed through OpenRouter with the upstream id `z-ai/glm-5.1`. With a Z.AI API key it talks to `api.z.ai`'s Anthropic-compatible endpoint directly. Default model on the Z.AI provider.",
    vm0Notes:
      "VM0 sets a 50-minute API timeout for the Z.AI provider so long thinking steps complete reliably without dropping, and pairs the model's 1M-token context with high-volume document agents that need the room.",
    vm0Tier: "cost-saving",
    byoKeyLabel: "Z.AI API key",
    vm0TimeoutMin: 50,

    bestForExamples: [
      {
        title: "The whole-repo refactor that fits in one prompt",
        body: "Drop a 500K-token mid-sized codebase into a single GLM-5.1 call and ask for a cross-file rename, an architectural review, or a security pass. Models with smaller windows force you to chunk the repo and stitch results together, which is where bugs creep in. GLM-5.1 keeps every file in working memory and references the right paths in its output.",
      },
      {
        title: "The research run over hundreds of documents",
        body: 'Wikis, RFCs, contracts, last year\'s support tickets — load the whole pile at once and ask for cross-document patterns. The cost-per-run stays manageable because of the low vendor price, which is what makes this kind of "read everything, summarise once" workflow actually affordable in production rather than a one-off science project.',
      },
      {
        title: "The thinking job that needs more than ten minutes",
        body: "Some agent steps genuinely take five to thirty minutes — deep research, multi-document analysis, long planning passes. VM0 sets a 50-minute API timeout for the Z.AI provider so those long thinking steps don't get cut off mid-thought, which makes GLM-5.1 the safe pick over models routed through providers with shorter default timeouts.",
      },
    ],
    avoidFor:
      "Skip GLM-5.1 on the hardest English-language reasoning where Sonnet 4.6 or Opus 4.7 still leads, and on latency-critical chat replies where Haiku 4.5 is much faster.",

    comparisons: [
      {
        vs: "Kimi K2.6",
        body: "Both are long-context options at similar credit cost (×0.4 vs ×0.3). Kimi has stronger long-context recall in our internal evaluation; GLM-5.1 wins on raw context size (1M vs 256K). Pick Kimi for very long transcripts; pick GLM-5.1 when you need to stuff a whole codebase into one prompt.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 (×1) leads on tool-routing accuracy and English-language reasoning. GLM-5.1 (×0.4) leads on context window and is the right pick when cost or context size dominates the decision.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro (×0.3) is cheaper and benchmarks higher on Code Arena per third-party reviews. GLM-5.1 still wins on context size. Pick DeepSeek for cost-sensitive standard-context work; pick GLM-5.1 when context size is the constraint.",
      },
    ],

    verdict:
      "Pick GLM-5.1 when context size is the constraint. For everything else, DeepSeek V4 Pro is cheaper and Sonnet 4.6 routes tools more reliably.",

    faqs: [
      {
        q: "How big is GLM-5.1's context window on VM0?",
        a: "Up to 1 million tokens. The largest in our Built-in lineup. Enough to fit a mid-sized repository or several hundred documents in a single prompt.",
      },
      {
        q: "Which provider should I use for GLM-5.1?",
        a: "VM0 Managed is the simplest path. If you want vendor-direct billing, connect a Z.AI API key.",
      },
      {
        q: "Is GLM-5.1 open weights?",
        a: "Z.AI publishes open-weight variants of the GLM series. The version exposed on VM0 routes to the Z.AI hosted API for production reliability.",
      },
      {
        q: "Does GLM-5.1 support image input?",
        a: "GLM-5.1 on VM0 is exposed for text and code. For multimodal (image/video) input, choose Claude Sonnet 4.6 or Kimi K2.6.",
      },
    ],

    alternatives: [
      {
        slug: "kimi-k2.6",
        reason: "Stronger long-context recall",
      },
      {
        slug: "deepseek-v4-pro",
        reason: "Cheaper alternative with shorter context",
      },
      {
        slug: "claude-sonnet-4-6",
        reason: "Stronger reasoning if cost isn't the constraint",
      },
    ],
    defaultFor: ["Z.AI"],
  },

  // -------------------------------------------------------------------------
  {
    slug: "claude-haiku-4-5",
    modelId: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    vendor: "Anthropic",
    multiplier: 0.3,

    metaTitle: "Claude Haiku 4.5 on VM0: SWE-bench, Pricing & Use Cases",
    metaDescription:
      "Claude Haiku 4.5 review on VM0. Fast, cheap Claude with SWE-bench Verified 73.3%. ×0.3 multiplier, $1/$5 pricing, 97 tok/sec, ideal for triage and routing.",
    pageTitle: "Claude Haiku 4.5 on VM0. Fast, cheap routing",
    tagline:
      "The fast, cheap Claude. Good enough for routing, short summarisation, and simple tool calls at a fraction of Sonnet's cost.",

    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "Available since launch",

    cardIntro:
      "The fast, cheap Claude. Good enough for routing, short summarisation, and simple tool calls at a fraction of Sonnet's cost.",

    summary:
      "Claude Haiku 4.5 is the small, fast Claude — replies run at roughly 97 output tokens per second (four to five times faster than Sonnet 4.5) and you can run it across a lot of traffic without watching the bill spiral.\n\nIt's still a real Claude: vendor-reported SWE-bench Verified hits 73.3%, only a few points behind Sonnet 4.5 at a third of the cost, and Augment's agentic-coding evaluation reportedly puts it at 90% of Sonnet 4.5's performance.\n\nVendor list price is $1 / $5 per 1M tokens with cached input at $0.10 / 1M. Reach for it as the high-throughput worker or sub-agent under a Sonnet- or Opus-led system; skip it when the loop is long and multi-step.",

    releaseDate: "Late 2025 (Claude 4.5 generation)",
    familyPosition:
      "Smallest tier of the Claude 4 family. Anthropic's high-throughput, low-latency option.",
    background: [
      "Claude Haiku 4.5 is the small, fast member of the Claude 4 family. It is built for latency-sensitive and high-volume work where Sonnet would be overkill. Single-tool calls, fast classifications, short summarisations, and simple Slack replies.",
      "Haiku 4.5 is remarkably capable for its tier. Anthropic's vendor-reported SWE-bench Verified score is 73.3%. Only ~4 points behind Sonnet 4.5 at one-third the cost. In Augment's agentic coding evaluation it reportedly hits 90% of Sonnet 4.5's performance, which puts it in genuine sub-agent territory.",
      "Despite being the small Claude, Haiku 4.5 is multimodal (vision-capable), supports prompt caching, and runs at ~97 tokens/sec. Comfortably the fastest model in our Built-in lineup.",
    ],

    architecture:
      "Haiku 4.5 ships with a 200K-token context window, multimodal input across text, vision, and code, and prompt caching that bills cached input at one-tenth the input rate. Output runs at roughly 97 tokens per second, four to five times faster than Sonnet 4.5.",

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "200K tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Best for", value: "High-volume / latency-sensitive flows" },
    ],

    benchmarks: [
      {
        name: "SWE-bench Verified",
        score: "73.3%",
        note: "vendor-reported, 50-trial average",
      },
      { name: "SWE-bench Pro", score: "39.5%", note: "third-party (Scale AI)" },
      {
        name: "OSWorld (computer use)",
        score: "50.7%",
        note: "vendor-reported",
      },
      { name: "Speed", score: "~97 tokens/sec", note: "vendor-reported" },
    ],
    benchmarksNote:
      "Vendor-reported numbers from Anthropic's Haiku 4.5 launch materials. Note that OpenAI flagged training-data contamination on SWE-bench Verified across all frontier models. Treat absolute numbers cautiously, but the relative ordering is robust.",

    pricing: {
      inputUsd: 1,
      outputUsd: 5,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 1.25,
    },

    performance: [
      {
        title: "Speed",
        body: "Fastest model in the Built-in lineup at ~97 tokens/sec. Reply latency is short enough for interactive Slack agents.",
      },
      {
        title: "Routing accuracy",
        body: "Good enough for single-tool flows; multi-tool routing is meaningfully behind Sonnet 4.6 on edge cases. Keep tool schemas tight.",
      },
      {
        title: "Reasoning",
        body: "Holds up on short tasks; loses track on long multi-step loops. Use it as a worker, not a planner.",
      },
      {
        title: "Cost",
        body: "Lowest cost in the Claude family on VM0. Prompt caching makes it the cheapest practical Anthropic option for repeated prompts.",
      },
    ],

    routingNotes:
      "Routed directly to Anthropic's Messages API. Available on VM0 Managed and the Anthropic / Claude Code OAuth providers.",
    vm0Notes:
      "Haiku 4.5 carries the lowest Claude multiplier (×0.3) and is the right pick for high-volume routing workloads, with prompt caching keeping the cost of repeated short prompts down. It doesn't carry Sonnet's multi-step agent quality, so design any Haiku-based agent to keep loops short and the tool surface narrow.",
    vm0Tier: "cost-saving",
    byoKeyLabel: "Anthropic API key",

    bestForExamples: [
      {
        title: "The Slack triage agent that feels instant",
        body: 'Reads every incoming message, classifies it ("bug report", "sales lead", "meeting request"), routes it to the right channel, and posts an acknowledgment in under two seconds. At Sonnet\'s speed the same flow would feel laggy; at Haiku\'s ~97 tokens per second it feels like the bot is actually paying attention in real time.',
      },
      {
        title: "The sub-agent under a Sonnet or Opus planner",
        body: 'Sonnet (or Opus) picks the strategy and breaks the request into ten narrow steps; Haiku executes each one. "Pull this CRM field, summarise this email, format this list" — none of those steps need flagship reasoning, and routing them to Haiku instead of running the whole loop on Sonnet drops the per-conversation cost dramatically without changing the output quality.',
      },
      {
        title: "The bulk classifier that runs on every record",
        body: "Tag a million tickets, extract the structured fields out of last quarter's email backlog, route a stream of inbound forms. Haiku's low per-token cost plus prompt caching on the (stable) system prompt means the unit cost per record is essentially noise on the budget, which is what makes \"classify everything\" workflows actually viable.",
      },
      {
        title: "The vision micro-task that needs to be fast",
        body: 'OCR a screenshot, identify what type of chart it is, pull a number out of a receipt image. Haiku 4.5 is multimodal and very fast, which means a UI agent that takes a screenshot every few seconds and asks "what just changed?" stays responsive instead of stuttering.',
      },
    ],
    avoidFor:
      "Skip Haiku 4.5 on long multi-step agent loops where it drops instructions after several turns, and on hard reasoning or code edits where Sonnet 4.6 or Opus 4.7 is the right call.",

    comparisons: [
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet (×1) is the default for full agents. Haiku (×0.3) is the right pick when speed and cost matter more than long-loop coherence. Typically as a worker under a Sonnet/Opus planner. Vendor benchmarks put Haiku within ~4 points of Sonnet 4.5 on SWE-bench Verified.",
      },
      {
        vs: "DeepSeek V4 Flash",
        body: "DeepSeek V4 Flash (×0.02) is much cheaper but with weaker tool-use and less reliable on multi-step loops. Use Flash for one-shot bulk work; use Haiku for short interactive Slack-style replies.",
      },
      {
        vs: "MiniMax M2.7",
        body: "MiniMax M2.7 (×0.1) is cheaper and stronger on multilingual tasks. Haiku 4.5 leads on English-language tool-routing reliability and is multimodal.",
      },
    ],

    verdict:
      "The Claude you put behind heavy load. Triage, classification, sub-agent under a Sonnet/Opus orchestrator — yes. Planner role — no, that's Sonnet's job.",

    faqs: [
      {
        q: "Is Haiku 4.5 multimodal?",
        a: "Yes. Haiku 4.5 accepts image inputs alongside text and code, so vision-driven agents work natively.",
      },
      {
        q: "How fast is Haiku 4.5?",
        a: "Anthropic reports ~97 tokens per second. 4 to 5 times faster than Sonnet 4.5. The fastest model in our Built-in lineup.",
      },
      {
        q: "When should I pick Haiku over Sonnet?",
        a: "Pick Haiku when (a) the agent loop is short. Usually under 5 turns, (b) latency matters more than reasoning depth, or (c) you need a cheap sub-agent under a Sonnet/Opus orchestrator.",
      },
      {
        q: "Can Haiku run multi-tool agents?",
        a: "It can, but accuracy drops on edge cases compared to Sonnet 4.6. Keep the tool surface narrow and the loop short, or fall back to Sonnet.",
      },
      {
        q: "What's Haiku 4.5's SWE-bench score?",
        a: "Anthropic reports 73.3% on SWE-bench Verified. Within ~4 points of Sonnet 4.5 at one-third the cost. On the harder SWE-bench Pro it scores 39.5% (Scale AI).",
      },
    ],

    alternatives: [
      {
        slug: "claude-sonnet-4-6",
        reason: "Step up when routing fidelity matters",
      },
      {
        slug: "deepseek-v4-flash",
        reason: "Even cheaper for single-shot tasks",
      },
      {
        slug: "minimax-m2.7",
        reason: "Cheap multilingual alternative",
      },
    ],
    defaultFor: [],
  },

  // -------------------------------------------------------------------------
  {
    slug: "kimi-k2.6",
    modelId: "kimi-k2.6",
    name: "Kimi K2.6",
    vendor: "Moonshot",
    multiplier: 0.3,

    metaTitle: "Kimi K2.6 on VM0: SWE-bench, Pricing & Long-Context Use",
    metaDescription:
      "Kimi K2.6 review on VM0. Moonshot's open-weight 1T-parameter MoE. SWE-bench Pro 58.6, ×0.3 credit cost, 256K context. Specs and recommended tasks.",
    pageTitle: "Kimi K2.6 on VM0. Long-context agents",
    tagline:
      "Moonshot's latest open-weight model. Best-in-class agentic benchmarks at the open-source frontier and a Claude-compatible interface.",

    contextWindowK: 256,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "April 2026",

    cardIntro:
      "Moonshot's latest. Best-in-class long-context recall in our internal evaluation and a Claude-compatible interface.",

    summary:
      "Kimi K2.6 is Moonshot's open-weight flagship and currently the strongest open-source agentic model on several public benchmarks. It sustains very long runs without losing the thread (Moonshot has documented unattended sessions of 12+ hours and 4,000+ tool calls) and accepts image and video input natively. Vendor-reported SWE-bench Pro hits 58.6 (above Claude Opus 4.6 and GPT-5.4 on that benchmark), and the hallucination rate dropped from K2.5's ~65% to ~39%.\n\nVendor list price is $0.60 / $3 per 1M tokens, open weights ship under a Modified MIT license, and the API is Anthropic-compatible. Reach for Sonnet 4.6 when production tool-routing reliability matters more than benchmark scores, and for Haiku when latency dominates.",

    releaseDate: "April 20, 2026",
    familyPosition:
      "Top of Moonshot's open-weight Kimi K2 series. Successor to K2.5 and K2 Thinking.",
    background: [
      "Kimi K2.6 is Moonshot AI's open-weight agentic model released April 20, 2026. It's a 1-trillion-parameter Mixture-of-Experts (MoE) model with 32B active parameters per token. The same architecture family as K2.5 and K2 Thinking, with substantial gains on agentic coding and long-horizon reasoning.",
      "K2.6 made a real splash on independent leaderboards. Vendor-reported scores put it ahead of GPT-5.4 (xhigh) and Claude Opus 4.6 (max effort) on SWE-bench Pro, with a hallucination rate of 39% (down from K2.5's 65%). Artificial Analysis ranks it #4 on its Intelligence Index. The leading open-weight option.",
      "On VM0 it's exposed via the Moonshot API key as the default model, through VM0 Managed at the same ×0.3 multiplier, and via OpenRouter. The API is Anthropic-compatible, so VM0 agents written for Claude work without code changes.",
    ],

    architecture:
      "K2.6 is a Mixture-of-Experts model with 1T total parameters and 32B active per token, fronted by a 256K-token context window and multimodal input across image and video (text-only output). Moonshot pairs it with an Agent Swarm runtime that scales horizontally to 300 sub-agents and 4,000 coordinated steps, and has documented long-horizon coding sessions of 12 hours or more. Open weights are published on Hugging Face under a Modified MIT License.",

    specs: [
      { label: "Family", value: "Kimi K2 series" },
      { label: "Parameters", value: "1T total / 32B active (MoE)" },
      { label: "Modalities", value: "Image, video, text" },
      { label: "Languages", value: "Multilingual" },
      { label: "Context window", value: "256K tokens" },
      { label: "License", value: "Modified MIT (open weights)" },
      { label: "Available on VM0", value: "April 2026" },
    ],

    benchmarks: [
      {
        name: "SWE-bench Pro",
        score: "58.6",
        note: "vendor-reported; beats GPT-5.4, Opus 4.6",
      },
      { name: "SWE-bench Verified", score: "80.2", note: "vendor-reported" },
      {
        name: "Terminal-Bench 2.0",
        score: "66.7",
        note: "Terminus-2 framework",
      },
      { name: "LiveCodeBench (v6)", score: "89.6", note: "vendor-reported" },
      {
        name: "HLE (with tools)",
        score: "54.0",
        note: "leads GPT-5.4 and Opus 4.6",
      },
      {
        name: "BrowseComp (Agent Swarm)",
        score: "86.3",
        note: "up from K2.5's 78.4",
      },
      {
        name: "Artificial Analysis Intelligence Index",
        score: "54",
        note: "#4 overall, leading open-weight",
      },
    ],
    benchmarksNote:
      "Vendor-reported scores from Moonshot's K2.6 release blog. Independent third parties (Artificial Analysis, TokenMix) corroborate the relative ordering. K2.6's hallucination rate dropped to 39% from K2.5's 65%. A significant safety/reliability improvement.",

    pricing: {
      inputUsd: 0.6,
      outputUsd: 3,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0.6,
    },

    performance: [
      {
        title: "Long-context recall",
        body: "Strongest long-context recall in our internal evaluation across the Built-in lineup. Maintains coherence across long agent transcripts where Anthropic Sonnet starts to drift.",
      },
      {
        title: "Agentic benchmarks",
        body: "Vendor-reported SWE-bench Pro 58.6 is the highest in the lineup at the time of writing. Beats GPT-5.4 and Opus 4.6.",
      },
      {
        title: "Long-horizon coding",
        body: "Documented 12+ hour autonomous sessions completing 4,000+ tool calls. The model genuinely sustains performance across very long runs.",
      },
      {
        title: "Tool use",
        body: "Reliable across common VM0 tool flows. The Anthropic-compatible API means tool schemas designed for Claude work directly.",
      },
    ],

    routingNotes:
      "Routed through Moonshot's Anthropic-compatible endpoint at `api.moonshot.ai`. Default model on the Moonshot provider; also available on VM0 Managed and via OpenRouter.",
    vm0Notes:
      "K2.6 has the strongest long-context recall in the Built-in lineup based on our internal evaluation, and at ×0.3 credits it's cheap enough to act as a viable Sonnet substitute for cost-sensitive work.",
    vm0Tier: "cost-saving",
    byoKeyLabel: "Moonshot API key",

    bestForExamples: [
      {
        title: "The investigation that has to read every old thread",
        body: 'Dig through six months of Slack conversations to find why a customer churned, comb the support-ticket backlog for a recurring bug pattern, or stitch together insights across a hundred RFCs. K2.6\'s long-context recall holds up across transcripts where Anthropic Sonnet starts dropping earlier turns, which is exactly what "reading the whole pile" workflows need.',
      },
      {
        title: "The autonomous refactor that runs overnight",
        body: "Moonshot has documented a 13-hour autonomous refactor of an eight-year-old matching engine, with K2.6 sustaining 4,000+ tool calls without drifting off task. That's the kind of run where most models lose the goal somewhere around hour two; K2.6's long-horizon stability is what makes \"start it Friday evening, check Monday morning\" actually work.",
      },
      {
        title: "The multimodal agent that handles screenshots and clips",
        body: "K2.6 accepts both image and video input through MoonViT, which is unusual outside the Claude family. Useful for screenshot-driven QA agents, document-vision pipelines, and any deployment where you'd otherwise have to splice in a separate vision model just to read images.",
      },
    ],
    avoidFor:
      "Skip K2.6 on the hardest tool-routing edge cases where Sonnet 4.6 still leads on production reliability, and on latency-critical chat replies where Haiku 4.5 is meaningfully faster.",

    comparisons: [
      {
        vs: "GLM-5.1",
        body: "Both are long-context options. K2.6 wins on raw long-context recall in our internal evaluation; GLM-5.1 wins on context size (1M vs 256K). Default to K2.6 for long transcripts; reach for GLM-5.1 only when you need >256K tokens in a single prompt.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet (×1) leads on multi-tool English-language routing reliability. K2.6 (×0.3) wins on cost and on agentic benchmarks (SWE-bench Pro). Pair them: Sonnet for complex tool-routing, K2.6 for cost-sensitive agent work.",
      },
      {
        vs: "Kimi K2.5",
        body: "K2.6 is the newer generation with stronger tool-use, lower hallucination rate (39% vs 65%), and better reasoning. K2.5 (×0.2) is slightly cheaper. Prefer K2.6 for new work.",
      },
    ],

    verdict:
      "The open-weight default for serious agent work — long-context, cost-effective. The remaining gaps versus Sonnet 4.6 are tool-routing reliability and enterprise support.",

    faqs: [
      {
        q: "When was Kimi K2.6 released?",
        a: "Moonshot AI released Kimi K2.6 on April 20, 2026. Open weights are published on Hugging Face under a Modified MIT License.",
      },
      {
        q: "What's the context window?",
        a: "256K tokens. K2.6 differentiates on recall quality at that size, not raw window size. Recall starts to degrade past ~180K (similar to other 256K models).",
      },
      {
        q: "Do I need to rewrite my agent to use Kimi?",
        a: "No. Kimi K2.6 exposes an Anthropic-compatible API, so VM0 agents tuned for Claude work without code changes.",
      },
      {
        q: "How does Kimi K2.6 compare to Claude Opus 4.6?",
        a: "On agentic benchmarks (vendor-reported), K2.6 leads. SWE-bench Pro 58.6 vs Opus 4.6's 53.4, HLE with tools 54.0 vs 53.0. Opus 4.6 retains an edge on safety profile and English-language tool-routing reliability in production.",
      },
      {
        q: "Does K2.6 support image input?",
        a: "Yes. K2.6 accepts image and video input. Text-only output. Multimodal agents work natively.",
      },
    ],

    alternatives: [
      {
        slug: "kimi-k2.5",
        reason: "Older generation, slightly cheaper multiplier",
      },
      { slug: "glm-5.1", reason: "Even longer context window (1M tokens)" },
      {
        slug: "deepseek-v4-pro",
        reason: "Cheaper alternative for cost-sensitive work",
      },
    ],
    defaultFor: ["Moonshot"],
  },

  // -------------------------------------------------------------------------
  {
    slug: "deepseek-v4-pro",
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    vendor: "DeepSeek",
    multiplier: 0.3,

    metaTitle: "DeepSeek V4 Pro on VM0: Benchmarks, Pricing & Comparison",
    metaDescription:
      "DeepSeek V4 Pro review on VM0. Open-weight 1.6T MoE with SWE-bench Verified 80.6%, ×0.3 credit cost, 1M context. Pricing, specs and Claude comparison.",
    pageTitle: "DeepSeek V4 Pro on VM0. Cost-optimised reasoning",
    tagline:
      "DeepSeek's flagship V4 reasoning model. Within 0.2 points of Claude Opus 4.6 on SWE-bench Verified at one-seventh the vendor cost. Claude-compatible API.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    releasedToVm0: "April 24, 2026",

    cardIntro:
      "DeepSeek's flagship. Strong reasoning at one-third of Sonnet's credit cost, Claude-compatible API.",

    summary:
      "DeepSeek V4 Pro is the flagship of DeepSeek's V4 generation — an open-weight 1.6T-parameter MoE under the MIT license. The headline is the price-to-quality ratio: vendor-reported SWE-bench Verified is 80.6%, within a fraction of a point of Claude Opus 4.6, at roughly one-seventh of Anthropic's vendor cost. That makes reasoning-heavy agents — bulk PR review, batch document analysis, scheduled summarisation — affordable at high volume.\n\nVendor list price is $1.74 / $3.48 per 1M tokens with cache reads at $0.028 / 1M and free cache writes (unique in the lineup). 1M-token context, Anthropic-compatible API. Reach for Sonnet 4.6 when production tool-routing reliability is the deciding factor, and for V4 Flash when single-shot bulk work justifies a 12× cheaper model.",

    releaseDate: "April 24, 2026",
    familyPosition:
      "Reasoning variant of the DeepSeek V4 family. Paired with V4 Flash for cost.",
    background: [
      "DeepSeek V4 Pro is the flagship of DeepSeek's V4 generation, released April 24, 2026 under the MIT License. It's an open-weight Mixture-of-Experts model with 1.6T total parameters and 49B active per token, paired with V4 Flash (284B / 13B active) for cost-sensitive work.",
      "Both V4 models share an identical feature set: 1M-token context window, 384K maximum output, three reasoning effort modes (standard, think, think-max), JSON output, tool calls, and FIM completion in non-think mode. The Pro model adds a hybrid attention architecture (Compressed Sparse Attention + Heavily Compressed Attention) for dramatically improved long-context efficiency. 27% of single-token inference FLOPs and 10% of KV cache vs DeepSeek V3.2 at 1M context.",
      "DeepSeek made waves through 2025 by delivering Anthropic-grade reasoning at a fraction of the price. V4 Pro continues that pattern: vendor-reported SWE-bench Verified 80.6% sits within 0.2 points of Claude Opus 4.6, at roughly one-seventh the vendor cost. On VM0 it's exposed via the DeepSeek API-key provider and on VM0 Managed at ×0.3. The same multiplier as Claude Haiku 4.5 but with substantially stronger reasoning behaviour.",
    ],

    architecture:
      "V4 Pro is a Mixture-of-Experts model with 1.6T total parameters and 49B active per token, fronted by a hybrid attention stack (Compressed Sparse Attention plus Heavily Compressed Attention) that keeps long-context inference cheap. It supports a 1M-token context window with 384K of maximum output, three reasoning effort modes (standard, think, and think-max), and uses Manifold-Constrained Hyper-Connections for stable signal propagation. The model was trained on 32T+ tokens with the Muon optimizer and is released under the MIT License with open weights.",

    specs: [
      { label: "Family", value: "DeepSeek V4 series" },
      { label: "Parameters", value: "1.6T total / 49B active (MoE)" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Multilingual" },
      { label: "Context window", value: "1M tokens" },
      { label: "Max output", value: "384K tokens" },
      { label: "License", value: "MIT (open weights)" },
      { label: "Available on VM0", value: "April 24, 2026" },
    ],

    benchmarks: [
      {
        name: "SWE-bench Verified",
        score: "80.6%",
        note: "vendor-reported; within 0.2pts of Opus 4.6",
      },
      {
        name: "Terminal-Bench 2.0",
        score: "67.9%",
        note: "vendor-reported; leads Opus 4.6",
      },
      { name: "LiveCodeBench", score: "93.5%", note: "vendor-reported" },
      { name: "Codeforces rating", score: "3206", note: "vendor-reported" },
      { name: "MMLU-Pro", score: "Matches GPT-5.4", note: "vendor-reported" },
      {
        name: "Artificial Analysis Intelligence Index",
        score: "52",
        note: "max effort",
      },
      { name: "Speed", score: "~36 tokens/sec", note: "Artificial Analysis" },
    ],
    benchmarksNote:
      "Vendor-reported scores from DeepSeek's V4 Pro release. Independent reviews (Geeky Gadgets, Code Arena) place V4 Pro third on Code Arena behind GLM-5.1 and Kimi K2.6. The strongest benchmark claims come from DeepSeek's own materials. Treat directionally rather than as absolute truth.",

    pricing: {
      inputUsd: 1.74,
      outputUsd: 3.48,
      cacheReadUsd: 0.145,
      cacheWriteUsd: null,
    },

    performance: [
      {
        title: "Reasoning",
        body: "Strongest sub-Sonnet reasoning in our lineup. Holds up on multi-step work where cheaper models start to drift. Vendor-reported MMLU-Pro matches GPT-5.4.",
      },
      {
        title: "Coding benchmarks",
        body: "Vendor-reported SWE-bench Verified 80.6% (within 0.2 of Opus 4.6), Terminal-Bench 2.0 67.9% (leads Opus 4.6), LiveCodeBench 93.5%.",
      },
      {
        title: "Cost efficiency",
        body: "The standout property. ×0.3 credit cost with reasoning that competes well with Sonnet 4.6 makes V4 Pro the cost-optimisation default. ~7× cheaper than Claude Opus 4.7.",
      },
      {
        title: "Cache economics",
        body: "Cache writes are free. Unique among VM0's Built-in models. Stable system prompts and large pasted reference docs cost nothing extra to cache, only the read side bills.",
      },
      {
        title: "Speed",
        body: "Around 36 tokens/sec at max effort per Artificial Analysis. Slower than Haiku, slightly slower than Opus 4.6.",
      },
    ],

    routingNotes:
      "Routed through DeepSeek's Anthropic-compatible endpoint at `api.deepseek.com`. Available on VM0 Managed and the DeepSeek provider.",
    vm0Notes:
      "DeepSeek bills cache reads but not cache writes, which is a real cost win whenever the system prompt is stable. VM0 sets a 10-minute API timeout for the DeepSeek provider and disables non-essential traffic to keep long-running agents responsive. The result is the strongest reasoning of any sub-Sonnet model in the Built-in lineup.",
    vm0Tier: "cost-saving",
    byoKeyLabel: "DeepSeek API key",
    vm0TimeoutMin: 10,

    bestForExamples: [
      {
        title: "The PR-review agent that runs on every commit",
        body: "Sonnet-tier accuracy at roughly one-third of Sonnet's vendor cost is what makes \"review every commit, not just the big PRs\" actually viable. V4 Pro reads the diff, the related files, and the linked issue, then writes a structured comment — and the per-call price is low enough that running it as a CI step on every push doesn't show up as a noticeable line item.",
      },
      {
        title: "The scheduled summariser that runs every night",
        body: "Pulls yesterday's customer conversations, support tickets, or sales calls and writes a digest. The system prompt and tool schema don't change between runs, and DeepSeek doesn't bill cache writes — so the long fixed prefix is paid for once and cached reads cost a fraction of normal input. This is where V4 Pro's pricing model genuinely changes what's affordable.",
      },
      {
        title: "The whole-repo code agent that costs less than Opus",
        body: '1M-token context with hybrid attention (Compressed Sparse Attention plus Heavily Compressed Attention) means a mid-sized codebase fits in one prompt and inference cost stays manageable as the window fills up. For cross-file refactors and architecture-level reviews, this is where you get the Opus-style "see everything at once" workflow without the Opus-style invoice.',
      },
    ],
    avoidFor:
      "Skip V4 Pro on the hardest tool-routing edge cases where Sonnet 4.6 still leads, and on bulk single-shot work where reasoning isn't required and V4 Flash is roughly 12× cheaper.",

    comparisons: [
      {
        vs: "DeepSeek V4 Flash",
        body: "Same vendor, different positioning. V4 Pro (×0.3) gives you reasoning; V4 Flash (×0.02) gives you the cheapest possible single-shot model. Vendor-reported SWE-bench Verified shows Flash within 1.6 points of Pro (79.0 vs 80.6). But Pro pulls ahead on Terminal-Bench (67.9 vs 56.9) on multi-step tool use.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 (×1) wins on tool-routing edge cases and English-language reasoning. V4 Pro (×0.3) wins on cost and is competitive on coding benchmarks (vendor-reported). Worth A/B-testing on a real agent before committing.",
      },
      {
        vs: "Kimi K2.6",
        body: "Same multiplier (×0.3). Kimi has stronger long-context recall and a higher Intelligence Index (54 vs 52); V4 Pro has the better cache economics (free writes) and a 1M context window vs Kimi's 256K. Pick by which property matters more.",
      },
    ],

    verdict:
      "Pre-filter with V4 Flash, escalate to V4 Pro for reasoning, escalate to Sonnet 4.6 only when V4 Pro stalls on tool-routing edge cases.",

    faqs: [
      {
        q: "When was DeepSeek V4 Pro released?",
        a: "DeepSeek released V4 Pro and V4 Flash together on April 24, 2026 under the MIT License with open weights.",
      },
      {
        q: "Why are cache writes free?",
        a: "DeepSeek doesn't bill the cache-write portion. Only cache reads bill, at $0.145 per 1M tokens. Stable system prompts and large reference contexts cost nothing extra to cache.",
      },
      {
        q: "What's V4 Pro's context window?",
        a: "1 million tokens with up to 384K tokens of output. The hybrid attention architecture makes the full window usable at much lower inference cost than V3.2.",
      },
      {
        q: "How does V4 Pro compare to Claude Opus 4.6?",
        a: "Vendor-reported SWE-bench Verified is within 0.2 points (80.6 vs 80.8). Terminal-Bench 2.0 favours V4 Pro (67.9 vs 65.4). Opus 4.6 leads on HLE (40.0 vs 37.7) and HMMT 2026 math (96.2 vs 95.2). At ~7× lower vendor cost, V4 Pro is the right call when reasoning quality is the bar but cost matters.",
      },
      {
        q: "Is V4 Pro open-source?",
        a: "Yes. Weights are published under the MIT License. The hosted DeepSeek API is the production path for VM0.",
      },
    ],

    alternatives: [
      { slug: "deepseek-v4-flash", reason: "12× cheaper, single-shot work" },
      { slug: "claude-sonnet-4-6", reason: "Step up for hard tool routing" },
      { slug: "kimi-k2.6", reason: "Same price, stronger long-context recall" },
    ],
    defaultFor: [],
  },

  // -------------------------------------------------------------------------
  {
    slug: "kimi-k2.5",
    modelId: "kimi-k2.5",
    name: "Kimi K2.5",
    vendor: "Moonshot",
    multiplier: 0.2,

    metaTitle: "Kimi K2.5 on VM0: Specs, Pricing & Migration to K2.6",
    metaDescription:
      "Kimi K2.5 review on VM0. Moonshot's previous flagship at ×0.2 credit cost. SWE-bench Pro 50.7, 256K context. When to pin K2.5 instead of K2.6.",
    pageTitle: "Kimi K2.5 on VM0. Moonshot's previous generation",
    tagline:
      "The previous Kimi generation. Cheaper than K2.6 but with weaker tool-use; pin it only if a specific agent was validated on this version.",

    contextWindowK: 256,
    promptCaching: true,
    modalities: ["Text", "Image", "Code"],
    releasedToVm0: "Available since launch",

    cardIntro:
      "The previous Kimi generation. Cheaper than K2.6 but with weaker tool-use; pin it only if a specific agent was validated on this version.",

    summary:
      "Kimi K2.5 is Moonshot's previous flagship, the open-weight model that K2.6 superseded in April 2026. It's still capable — strong on long-context summarisation — but K2.6 leads on every published benchmark at the same vendor price, and the hallucination rate gap is wide (K2.5 ~65% on Moonshot's evaluation versus K2.6's ~39%).\n\nVendor list price is $0.60 / $3 per 1M tokens, identical to K2.6. The honest pitch: if you built on K2.5 and it works, leave it; if you're starting fresh, start on K2.6.",

    releaseDate: "Late 2025 (Kimi K2 series)",
    familyPosition:
      "Previous generation of Moonshot's open-weight Kimi K2 series. Superseded by K2.6.",
    background: [
      "Kimi K2.5 was Moonshot's flagship Kimi model before K2.6. It was the first widely-deployed Kimi to combine long-context reasoning with a Claude-compatible API surface, and it remains a capable model for long-context summarisation work.",
      "On VM0 it sits at the same vendor list price as K2.6 but a lower credit multiplier (×0.2). The lower multiplier reflects positioning rather than raw token cost. K2.6 is the recommended default for new work; K2.5 is the legacy pin.",
      "K2.5 has a vendor-reported SWE-bench Pro score of 50.7 and a hallucination rate of ~65%. Both meaningfully behind K2.6 (58.6 and 39%). Behaviourally it remains stable for pinned production agents.",
    ],

    architecture:
      "K2.5 is a Mixture-of-Experts model with 1T total parameters and 32B active per token from the same family as K2.6, fronted by a 256K-token context window and an Anthropic-compatible API surface. Open weights are published on Hugging Face.",

    specs: [
      { label: "Family", value: "Kimi K2 series" },
      { label: "Modalities", value: "Image, text, code" },
      { label: "Languages", value: "Multilingual" },
      { label: "Context window", value: "256K tokens" },
      { label: "License", value: "Modified MIT (open weights)" },
      { label: "Available on VM0", value: "Available since launch" },
    ],

    benchmarks: [
      { name: "SWE-bench Pro", score: "50.7", note: "vendor-reported" },
      { name: "BrowseComp", score: "78.4", note: "vendor-reported" },
      {
        name: "Hallucination rate",
        score: "~65%",
        note: "down to 39% in K2.6",
      },
    ],
    benchmarksNote:
      "K2.5's benchmarks are now most useful as the comparison baseline for K2.6. The newer model leads on every published metric at the same vendor cost.",

    pricing: {
      inputUsd: 0.6,
      outputUsd: 3,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0.6,
    },

    performance: [
      {
        title: "Long-context",
        body: "Strong, similar shape to K2.6 but with K2.6 having the edge on harder recall benchmarks.",
      },
      {
        title: "Tool use",
        body: "Solid on common flows; K2.6 is meaningfully better on complex multi-tool agents.",
      },
      {
        title: "Hallucinations",
        body: "Vendor-reported hallucination rate of ~65%. Much higher than K2.6's 39%. Expect more confident-but-wrong outputs.",
      },
    ],

    routingNotes:
      "Routed through Moonshot's Anthropic-compatible endpoint at `api.moonshot.ai`. Available on VM0 Managed, Moonshot, OpenRouter, and Vercel AI Gateway.",
    vm0Notes:
      "K2.5 carries the same per-token vendor price as K2.6 but a lower multiplier (×0.2 versus ×0.3) because the multiplier reflects positioning rather than raw cost. Long-context behaviour is solid, but K2.6 is the recommended choice for any new work on VM0.",
    vm0Tier: "cost-saving",
    byoKeyLabel: "Moonshot API key",

    bestForExamples: [
      {
        title: "The legacy agent that already works",
        body: "Your team validated an agent against K2.5 a few months ago, the prompts are tuned, the eval suite passes, customers are happy. Pinning to K2.5 keeps that exact behaviour in place while you decide whether the K2.6 upgrade is worth re-running the validation. Same Moonshot endpoint, same Anthropic-compatible interface — only the model weights move when you switch.",
      },
      {
        title: "The bulk-summarisation job where K2.6's edge doesn't show",
        body: "Hundred-thousand-token transcripts going in, three-paragraph summaries coming out. Tool-routing accuracy isn't part of the workload, hallucination resistance matters less when a human is going to skim the output anyway, and at the same vendor price as K2.6 you can run K2.5 on these jobs without touching the existing pipeline.",
      },
    ],
    avoidFor:
      "Don't start new agents on K2.5, since K2.6 is a free upgrade in every meaningful way except the multiplier. Skip it on multi-tool English routing where Sonnet 4.6 leads, and on tasks where hallucination is costly because K2.5's rate is materially worse than K2.6's.",

    comparisons: [
      {
        vs: "Kimi K2.6",
        body: "K2.6 is the newer generation with stronger tool-use, lower hallucination rate (39% vs 65%), and better reasoning. K2.5 (×0.2) is slightly cheaper. Pick K2.5 only for pinned legacy agents.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro (×0.3) has stronger reasoning. K2.5 (×0.2) wins on context size and stays within the Moonshot API surface.",
      },
    ],

    verdict:
      "Maintenance mode. Pin if you have an agent already validated on it; otherwise start on K2.6.",

    faqs: [
      {
        q: "Why does K2.5 have a lower multiplier than K2.6 at the same vendor price?",
        a: "Multipliers reflect VM0's positioning of each model in the lineup, not just per-token cost. K2.6 is the recommended Kimi default at ×0.3; K2.5 is positioned as legacy at ×0.2.",
      },
      {
        q: "Should I migrate from K2.5 to K2.6?",
        a: "Yes for new work. Same vendor price, stronger tool-use and reasoning, much lower hallucination rate. Migrate pinned agents only after running them through your regression suite.",
      },
      {
        q: "What's the hallucination rate?",
        a: "Vendor-reported ~65%. Meaningfully higher than K2.6 (39%). If your agent reports facts to users, this matters; consider K2.6 instead.",
      },
      {
        q: "What's K2.5's context window?",
        a: "256K tokens. Same as K2.6.",
      },
    ],

    alternatives: [
      { slug: "kimi-k2.6", reason: "Newer Kimi with better tool-use" },
      { slug: "glm-5.1", reason: "Larger context window if you need it" },
      {
        slug: "deepseek-v4-pro",
        reason: "Stronger reasoning at slightly higher multiplier",
      },
    ],
    defaultFor: [],
  },

  // -------------------------------------------------------------------------
  {
    slug: "minimax-m2.7",
    modelId: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    vendor: "MiniMax",
    multiplier: 0.1,

    metaTitle: "MiniMax M2.7 on VM0: Pricing, Specs & Multilingual Use",
    metaDescription:
      "MiniMax M2.7 review on VM0. Strong multilingual reasoning at ×0.1 credit cost, 50-min API timeout. Pricing and tasks.",
    pageTitle: "MiniMax M2.7 on VM0. Multilingual at ×0.1",
    tagline:
      "Strong multilingual reasoning at one-tenth of Sonnet's credit cost. Generous timeout for long thinking steps.",

    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Code"],
    releasedToVm0: "Available since launch",

    cardIntro:
      "Strong multilingual reasoning at one-tenth of Sonnet's credit cost. Generous timeout for long thinking steps.",

    summary:
      "MiniMax M2.7 is the cheap multilingual workhorse in the lineup. Reach for it when the agent's primary language isn't English and unit cost matters: multilingual reply drafting, mixed-language support triage, scheduled summarisation over non-English corpora. It's not trying to outscore Sonnet on English benchmarks; it's keeping multilingual production traffic affordable.\n\nVendor list price is $0.30 / $1.20 per 1M tokens, API is Anthropic-compatible. VM0 sets a 50-minute API timeout for the MiniMax provider so long thinking steps complete reliably. Reach for Sonnet 4.6 on English tool-use and Haiku 4.5 on latency-critical replies.",

    releaseDate: "Available since the M2 series launch",
    familyPosition: "Latest text reasoning model in MiniMax's M2 series.",
    background: [
      "MiniMax M2.7 is from MiniMax, an AI lab with a multilingual and multimodal product line. The text reasoning side is what's exposed on VM0; MiniMax's image and voice products are separate offerings on the lab's platform.",
      "On VM0, M2.7 is the default model on the MiniMax API-key provider. The Built-in lineup carries it at ×0.1. One of the lowest multipliers in the catalogue. Making it the default cheap-but-credible reasoner for multilingual workloads.",
      "VM0's MiniMax provider sets a 50-minute API timeout and disables non-essential traffic, so long thinking steps complete reliably without dropping connections.",
    ],

    architecture:
      "M2.7 exposes an Anthropic-compatible API surface with a 200K-token context window and multilingual coverage. It runs at `api.minimax.io`.",

    specs: [
      { label: "Family", value: "MiniMax M2 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Multilingual" },
      { label: "Context window", value: "200K tokens" },
      { label: "Prompt caching", value: "Supported (Anthropic-compatible)" },
      { label: "Available on VM0", value: "Available since launch" },
    ],

    benchmarks: [
      {
        name: "English multi-tool routing",
        score: "Below Sonnet 4.6",
        note: "VM0 internal",
      },
    ],
    benchmarksNote:
      "MiniMax publishes fewer head-to-head benchmark numbers than Anthropic, Moonshot, or DeepSeek. We've kept this section honest. Pick M2.7 based on language profile and cost positioning rather than chasing leaderboards.",

    pricing: {
      inputUsd: 0.3,
      outputUsd: 1.2,
      cacheReadUsd: 0.06,
      cacheWriteUsd: 0.375,
    },

    performance: [
      {
        title: "Multilingual",
        body: "Stronger on multilingual flows than the Anthropic family. The natural pick when the agent's primary language isn't English.",
      },
      {
        title: "Reasoning",
        body: "Solid for general agent work; below Sonnet 4.6 and Kimi K2.6 on the hardest tool-routing edge cases.",
      },
      {
        title: "Latency",
        body: "Slower than Haiku 4.5; the 50-minute VM0 timeout means very long thinking steps survive without dropping.",
      },
    ],

    routingNotes:
      "Routed through MiniMax's Anthropic-compatible endpoint at `api.minimax.io`. Default model on the MiniMax provider; also available on VM0 Managed.",
    vm0Notes:
      "VM0 sets a 50-minute API timeout for the MiniMax provider and disables non-essential traffic, so long thinking steps survive without dropping. The ×0.1 multiplier is the lowest non-Flash multiplier in the lineup, which is why M2.7 pairs naturally with high-volume multilingual workloads.",
    vm0Tier: "cost-saving",
    byoKeyLabel: "MiniMax API key",
    vm0TimeoutMin: 50,

    bestForExamples: [
      {
        title: "The multilingual customer agent that sounds native",
        body: "Drafting replies, triaging tickets, holding multilingual chat threads where the conversation switches between languages mid-message. M2.7's training emphasised multilingual coverage, so the output reads more naturally for non-English-speaking customers than the same prompt routed through an English-first model would.",
      },
      {
        title: "The overnight summariser running over multilingual content",
        body: "Last quarter's customer conversations, a year of bilingual support tickets, a stack of multilingual regulatory documents — bulk summarisation jobs where speed isn't critical but unit cost matters a lot. M2.7's vendor price keeps the cost of \"summarise everything\" workflows low enough that they can run on every batch instead of every other week.",
      },
      {
        title: "The thinking job that needs a long fuse",
        body: "Multi-step reasoning passes that genuinely take ten minutes or more — deep research, document analysis, planning chains. VM0's MiniMax provider runs with a 50-minute API timeout (and disables non-essential traffic), so those long thinking steps complete cleanly instead of getting cut off and forcing a retry.",
      },
    ],
    avoidFor:
      "Skip M2.7 on English-first multi-tool agents where Sonnet 4.6 is more reliable, and on latency-critical replies where Haiku 4.5 is faster.",

    comparisons: [
      {
        vs: "Kimi K2.6",
        body: "Kimi K2.6 (×0.3) has stronger reasoning and tool-use. M2.7 (×0.1) is one-third the cost and has a stronger multilingual profile. Default to Kimi for general work; reach for MiniMax for cheap multilingual background jobs.",
      },
      {
        vs: "DeepSeek V4 Flash",
        body: "Both are sub-Haiku in cost. V4 Flash is faster and even cheaper (×0.02) but with weaker reasoning. M2.7 is the better pick when the work needs more than one-shot reasoning.",
      },
      {
        vs: "GLM-5.1",
        body: "GLM-5.1 (×0.4) is more capable on long-context English-language work. M2.7 (×0.1) is much cheaper and the right pick when language profile and budget dominate.",
      },
    ],

    verdict:
      "The cheap multilingual default. Use it when language profile and budget call for it; reach for Kimi K2.6 or Sonnet 4.6 when raw quality matters.",

    faqs: [
      {
        q: "What's the API timeout?",
        a: "VM0 sets a 50-minute timeout for the MiniMax provider, plus a flag to suppress non-essential traffic. Long thinking steps complete reliably.",
      },
      {
        q: "Does MiniMax M2.7 support image input?",
        a: "M2.7 on VM0 is the text reasoning model. MiniMax sells multimodal products separately; image and voice generation aren't part of the VM0 Built-in agent surface today.",
      },
      {
        q: "Why is the multiplier so low (×0.1)?",
        a: "Vendor list price is genuinely low ($0.30/$1.20 per 1M) and VM0 prices the model accordingly. Use it as a cheap multilingual workhorse, not a reasoning replacement for Sonnet.",
      },
    ],

    alternatives: [
      { slug: "kimi-k2.6", reason: "Stronger reasoning at a similar price" },
      { slug: "deepseek-v4-flash", reason: "Even cheaper if quality permits" },
      {
        slug: "claude-haiku-4-5",
        reason: "Anthropic alternative for fast triage",
      },
    ],
    defaultFor: ["MiniMax"],
  },

  // -------------------------------------------------------------------------
  {
    slug: "deepseek-v4-flash",
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    vendor: "DeepSeek",
    multiplier: 0.02,

    metaTitle: "DeepSeek V4 Flash on VM0: Cheapest Model, Benchmarks & Price",
    metaDescription:
      "DeepSeek V4 Flash review on VM0. The cheapest Built-in model at ×0.02 credit cost ($0.14/$0.28). Vendor-reported SWE-bench Verified 79%, 1M context. Use cases.",
    pageTitle: "DeepSeek V4 Flash on VM0. The cheapest model",
    tagline:
      "The cheapest model in the lineup. 50× less than Sonnet 4.6. Surprisingly capable for its tier. Vendor-reported SWE-bench Verified within 1.6 points of V4 Pro.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    releasedToVm0: "April 24, 2026",

    cardIntro:
      "The cheapest model in the lineup. 50× less than Sonnet 4.6. Good for high-volume single-shot tasks where the prompt does most of the work.",

    summary:
      "DeepSeek V4 Flash is the cost-leader of the V4 generation, engineered for the absolute lowest unit cost in the lineup. It's good at single-shot work where the prompt does most of the lifting: tagging a million tickets, extracting structured fields from email backlogs, scoring reviews, pre-filtering records before the hard cases go to a stronger model. Vendor-reported SWE-bench Verified is 79.0% (within 1.6 points of V4 Pro), but Terminal-Bench 2.0 lags by 11 points — that's where Flash trails: long multi-step tool chains.\n\nVendor list price is $0.14 / $0.28 per 1M tokens with cache reads at $0.028 / 1M and free cache writes. Don't put Flash in a planner role; for that, V4 Pro or Sonnet 4.6. Everywhere else cost dominates, nothing competes.",

    releaseDate: "April 24, 2026",
    familyPosition:
      "Cost-leader of DeepSeek's V4 family. Paired with V4 Pro for reasoning.",
    background: [
      "DeepSeek V4 Flash is the cost-leader in DeepSeek's V4 generation, released April 24, 2026 alongside V4 Pro. Where V4 Pro is positioned for reasoning, Flash is positioned for the absolute lowest unit cost. A model you can run at very high volumes without thinking about budget.",
      "Flash is a 284B-parameter MoE with 13B active per token (vs Pro's 1.6T / 49B). Both share the V4 family's identical feature set: 1M-token context, 384K maximum output, three reasoning effort modes, JSON output, and tool calls.",
      "On VM0 it carries a ×0.02 credit multiplier. The lowest in the entire Built-in catalogue. That makes it the default for bulk classification, tagging, extraction, and pre-filter workloads where the prompt does most of the work and the model just needs to follow instructions reliably. It shares the V4 family's free cache-write economics: only cache reads bill.",
    ],

    architecture:
      "V4 Flash is a Mixture-of-Experts model with 284B total parameters and 13B active per token, fronted by a 1M-token context window with 384K of maximum output. It exposes three reasoning effort modes (standard, think, and think-max), bills only cache reads (cache writes are free), and ships under the MIT License with open weights.",

    specs: [
      { label: "Family", value: "DeepSeek V4 series" },
      { label: "Parameters", value: "284B total / 13B active (MoE)" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Multilingual" },
      { label: "Context window", value: "1M tokens" },
      { label: "Max output", value: "384K tokens" },
      { label: "License", value: "MIT (open weights)" },
      { label: "Available on VM0", value: "April 24, 2026" },
    ],

    benchmarks: [
      {
        name: "SWE-bench Verified",
        score: "79.0%",
        note: "vendor-reported; within 1.6pts of V4 Pro",
      },
      {
        name: "Terminal-Bench 2.0",
        score: "56.9%",
        note: "vendor-reported; trails V4 Pro by 11pts",
      },
      {
        name: "SimpleQA-Verified",
        score: "34.1%",
        note: "vendor-reported; trails V4 Pro",
      },
    ],
    benchmarksNote:
      "Vendor-reported scores from DeepSeek's V4 release. Flash matches Pro on simpler benchmarks but loses ground on multi-step tool use (Terminal-Bench) and factual recall (SimpleQA). Exactly what you'd expect from the smaller MoE.",

    pricing: {
      inputUsd: 0.14,
      outputUsd: 0.28,
      cacheReadUsd: 0.028,
      cacheWriteUsd: null,
    },

    performance: [
      {
        title: "Cost",
        body: "By far the lowest cost in the Built-in lineup. The right pick whenever unit cost dominates the decision.",
      },
      {
        title: "Single-shot accuracy",
        body: "Good when the prompt is explicit and the task fits in one or two turns. Drops noticeably when asked to plan, branch, and remember across many steps.",
      },
      {
        title: "Multi-step tool use",
        body: "Vendor-reported Terminal-Bench 2.0 is 56.9% (vs V4 Pro's 67.9%). Meaningfully behind on complex multi-step tool flows. Don't put V4 Flash in a planner role.",
      },
      {
        title: "Context window",
        body: "1M tokens. Same as V4 Pro and far larger than Anthropic Haiku (200K).",
      },
    ],

    routingNotes:
      "Routed through DeepSeek's Anthropic-compatible endpoint at `api.deepseek.com`. Default model on the DeepSeek provider; also available on VM0 Managed.",
    vm0Notes:
      "V4 Flash carries the lowest credit multiplier of any Built-in model (×0.02), roughly 50× less than Sonnet 4.6. Cache reads bill while cache writes are free, and VM0 sets a 10-minute API timeout for the DeepSeek provider that pairs naturally with Flash's short single-shot work.",
    vm0Tier: "cost-saving",
    byoKeyLabel: "DeepSeek API key",
    vm0TimeoutMin: 10,

    bestForExamples: [
      {
        title: "The classifier that runs on every record without flinching",
        body: 'Tag a million tickets by category, route inbound forms to the right team, score every review on the dimensions that matter. Per-record cost on Flash is fractions of a cent, which is what makes "classify everything as it arrives" workflows actually sustainable instead of getting throttled to a sample.',
      },
      {
        title: "The pre-filter in front of a stronger model",
        body: "Run V4 Flash on every record first, then route the top 5% (or the cases Flash isn't confident about) up to V4 Pro or Sonnet 4.6. Two-stage pipelines beat single-model pipelines on total cost almost every time — Flash handles the easy 95%, the stronger model only sees the hard 5%, and your bill scales with reasoning need rather than total volume.",
      },
      {
        title:
          "The bulk-extraction job that pulls structured data from anywhere",
        body: "Email backlogs, PDFs, meeting transcripts, scanned invoices — anywhere there's a fixed system prompt asking for the same JSON shape. Flash bills cache reads but not cache writes, so the long fixed prefix that defines the output schema is paid for once and amortises across the entire batch, driving the marginal per-document cost close to zero.",
      },
      {
        title: "The long-document one-shot Q&A",
        body: 'Drop a whole book, a 200-page contract, or a codebase into the 1M-token context window and ask a single targeted question. Flash answers in one shot at fractions of a cent per call — more than fast enough for answering "does this document mention X?" across a long document at scale, which is one of the workflows agentic loops genuinely don\'t help with.',
      },
    ],
    avoidFor:
      "Skip V4 Flash on multi-step agent loops where it drifts on long tool chains, and on hard reasoning, code edits, or planner roles where V4 Pro or Sonnet 4.6 is the right call.",

    comparisons: [
      {
        vs: "DeepSeek V4 Pro",
        body: "Same vendor; V4 Pro (×0.3) does the reasoning, V4 Flash (×0.02) does the volume. The classic split: Flash as the pre-filter, Pro as the escalator. Vendor-reported SWE-bench Verified is within 1.6 points (79.0 vs 80.6); Terminal-Bench 2.0 favours Pro by 11 points (67.9 vs 56.9).",
      },
      {
        vs: "Claude Haiku 4.5",
        body: "Haiku 4.5 (×0.3) is more reliable on multi-tool routing and faster on interactive flows. V4 Flash (×0.02) wins on raw cost and context size. Pick Flash for batch jobs; pick Haiku for interactive Slack-style replies.",
      },
      {
        vs: "MiniMax M2.7",
        body: "M2.7 (×0.1) is stronger on multilingual reasoning and has a 50-minute timeout for long thinking. V4 Flash (×0.02) is faster and far cheaper for single-shot work.",
      },
    ],

    verdict:
      "The cheapest model in the catalogue. Right for bulk tagging, extraction, and pre-filtering; wrong for planner roles or long agent loops.",

    faqs: [
      {
        q: "When was DeepSeek V4 Flash released?",
        a: "DeepSeek released V4 Flash and V4 Pro together on April 24, 2026 under the MIT License with open weights.",
      },
      {
        q: "Should I run my entire agent on V4 Flash?",
        a: "Probably not. Flash is great at one-shot tasks but drifts on long multi-step loops (vendor-reported Terminal-Bench 2.0 is 11 points behind V4 Pro). The standard pattern is to use it as a pre-filter and escalate the hard cases to V4 Pro or Sonnet 4.6.",
      },
      {
        q: "Are cache writes really free?",
        a: "Yes. DeepSeek doesn't bill the cache-write portion. Only cache reads bill, at $0.028 per 1M tokens.",
      },
      {
        q: "Is V4 Flash open-source?",
        a: "Yes. Weights are published under the MIT License (284B total / 13B active MoE). The hosted DeepSeek API is the production path for VM0.",
      },
      {
        q: "What's V4 Flash's context window?",
        a: "1 million tokens. Identical to V4 Pro. Useful for long-document one-shot Q&A even at the cheapest tier.",
      },
    ],

    alternatives: [
      {
        slug: "deepseek-v4-pro",
        reason: "Same vendor, much stronger reasoning",
      },
      { slug: "claude-haiku-4-5", reason: "Anthropic alternative for routing" },
      { slug: "minimax-m2.7", reason: "Cheap multilingual alternative" },
    ],
    defaultFor: ["DeepSeek"],
  },
];

export function getModelBySlug(slug: string): ModelEntry | undefined {
  return MODELS.find((m) => {
    return m.slug === slug;
  });
}

export const MODEL_SLUGS = MODELS.map((m) => {
  return m.slug;
});
