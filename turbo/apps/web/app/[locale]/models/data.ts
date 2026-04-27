// ---------------------------------------------------------------------------
// Models — Built-in lineup shown on /models and /models/[slug].
//
// Order, multipliers, pricing, and routing facts mirror the platform:
//   - turbo/packages/api-contracts/src/contracts/model-providers.ts
//     (VM0_MODEL_TO_PROVIDER, MODEL_PROVIDER_TYPES)
//   - turbo/apps/platform/.../settings/provider-ui-config.ts
//     (VM0_MODEL_CREDIT_MULTIPLIER)
//   - turbo/apps/web/scripts/dev-seed.ts (MODEL_PRICING — USD per 1M tokens)
//
// Benchmark scores are vendor-reported public numbers; cite carefully.
// ---------------------------------------------------------------------------

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
  /** Sub-headline / tagline shown under the H1. 1–2 sentences. */
  tagline: string;

  // Hero quick facts
  contextWindowK: number;
  promptCaching: boolean;
  modalities: string[];
  chinaAccessible: boolean;
  releasedToVm0: string;

  // List page
  cardIntro: string;
  cardBestFor: string[];
  cardAvoidFor: string[];

  // TL;DR
  summaryPoints: string[];

  // Overview / release
  /** Vendor release date. e.g. "April 20, 2026" or "February 2026". */
  releaseDate: string;
  /** Where the model sits in its family — for SEO scanability. */
  familyPosition: string;
  /** 1–3 paragraphs about the model itself (vendor-neutral). */
  background: string[];

  // Architecture / what's new
  /** Headline architectural / capability bullets. Optional. */
  architecture: string[];

  // Specs
  specs: SpecRow[];

  // Benchmarks
  /** Vendor-reported public benchmark scores. */
  benchmarks: BenchmarkScore[];
  /** 1-paragraph context for the benchmark table. */
  benchmarksNote: string;

  // Pricing
  pricing: ModelPricing;
  /** Worked example string for VM0 Managed credit cost. */
  vm0CostExample: string;

  // Performance
  performance: PerformanceNote[];

  // VM0 routing
  routingNotes: string;
  vm0Notes: string[];
  vm0TimeoutMin?: number;

  // Best for
  bestForExamples: BestForExample[];
  avoidFor: string[];

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

    metaTitle: "Claude Opus 4.7 on VM0: Benchmarks, Pricing & Use Cases",
    metaDescription:
      "Claude Opus 4.7 review on VM0 — Anthropic's strongest reasoning model. SWE-bench performance, $5/$25 pricing, 1M-token context, and the agent tasks it handles best.",
    pageTitle: "Claude Opus 4.7 on VM0",
    tagline:
      "Anthropic's strongest reasoning model. The pick for the hardest agent steps when nothing else holds together — at the highest credit cost in the lineup.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    chinaAccessible: false,
    releasedToVm0: "April 17, 2026",

    cardIntro:
      "Anthropic's strongest model. Highest reasoning quality on multi-step agent loops, long-context recall, and code edits — at the highest credit cost in the lineup.",
    cardBestFor: [
      "Complex agent tasks that require reasoning across many tools",
      "Long-running runs with 100k+ tokens of accumulated context",
      "Code edits where the patch needs to apply cleanly on the first try",
    ],
    cardAvoidFor: [
      "High-volume routine tasks where Sonnet 4.6 or Haiku 4.5 is enough",
    ],

    summaryPoints: [
      "Anthropic's strongest model — best in class on long-horizon agent loops.",
      "×1.7 credits on VM0; $5 / $25 per 1M tokens at the vendor.",
      "Use as the orchestrator or for the hardest steps; route easy work to Sonnet 4.6 or Haiku 4.5.",
    ],

    releaseDate: "April 2026 (succeeding Opus 4.6)",
    familyPosition:
      "Top-tier of the Claude 4 family — Anthropic's recommended upgrade for users on Opus 4.6.",
    background: [
      "Claude Opus 4.7 is the top-tier model in Anthropic's Claude 4 family. Anthropic positions it as the recommended upgrade for users currently on Opus 4.6, citing improved intelligence and a step-change jump in agentic coding behaviour.",
      "Compared to Sonnet 4.6, Opus invests more compute per token. The result is fewer dropped instructions on long agent loops, more reliable code patching, and stronger recall when the conversation history grows past 100K tokens. The tradeoff is the highest list price in the Built-in lineup.",
      "Opus 4.7 became available on VM0 on April 17, 2026 (PR #9709). It runs through Anthropic's standard Messages API with prompt caching enabled, so repeated system prompts and tool definitions don't pay the full input rate after the first call.",
    ],

    architecture: [
      "1M-token context window (full window at standard pricing, same as Opus 4.6)",
      "Adaptive thinking with four effort levels (low / medium / high / max)",
      "Compaction API for server-side context summarisation on long runs",
      "Prompt caching with cached input billed at one-tenth the input rate",
      "Multimodal input — text, vision, and code",
    ],

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "1M tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Region", value: "Global; not directly reachable from China" },
      { label: "Available on VM0", value: "April 17, 2026" },
    ],

    benchmarks: [
      { name: "SWE-bench Verified", score: "Highest in Claude family at release", note: "vendor-reported" },
      { name: "Terminal-Bench 2.0", score: "Step-change jump vs Opus 4.6", note: "vendor-reported" },
      { name: "Long-context recall (1M)", score: "Best in class for Anthropic", note: "MRCR-style evaluation" },
    ],
    benchmarksNote:
      "Anthropic positions Opus 4.7 as a clear improvement over Opus 4.6 across agentic-coding and reasoning suites. Treat exact percentages as a moving target — leaderboards refresh frequently.",

    pricing: {
      inputUsd: 5,
      outputUsd: 25,
      cacheReadUsd: 0.5,
      cacheWriteUsd: 6.25,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$0.375 in vendor list price ($0.25 input + $0.125 output) — billed as ×1.7 of Sonnet 4.6 on VM0 Managed.",

    performance: [
      {
        title: "Tool routing",
        body: "Lowest rate of mis-routed tool calls in our internal Built-in lineup. Meaningfully better than Sonnet 4.6 on hard edge cases.",
      },
      {
        title: "Long-context recall",
        body: "Coherent across 200K+ token agent transcripts. The 1M-token window holds up far better than predecessors thanks to Anthropic's context-rot improvements introduced in Opus 4.6.",
      },
      {
        title: "Code edits",
        body: "First-attempt patch quality is the strongest in the lineup. Right pick when an agent has to modify code that must keep compiling and passing tests.",
      },
      {
        title: "Speed",
        body: "Slower than Sonnet 4.6 and noticeably slower than Haiku 4.5. Reserve it for the steps where you actually need the extra reasoning depth.",
      },
    ],

    routingNotes:
      "Routed directly to Anthropic's Messages API. Available on the VM0 Managed pool, the Anthropic API-key provider, and the Claude Code OAuth provider.",
    vm0Notes: [
      "Most expensive Built-in model — Sonnet 4.6 is VM0's default for a reason. Promote to Opus 4.7 for orchestration and the hardest steps.",
      "Prompt caching is supported and substantially cuts cost on repeated system prompts, tool definitions, and pasted reference docs.",
      "No special timeout overrides — uses Anthropic's default timeouts.",
    ],

    bestForExamples: [
      {
        title: "Engineering agents that touch code",
        body: "Repository-aware refactors, PR review, bug-bisection — anywhere a wrong patch silently breaks tests. Opus's first-attempt accuracy pays for itself.",
      },
      {
        title: "Multi-tool research agents",
        body: "Deep investigations across Slack, GitHub, Linear, and the web that span 50+ tool calls. Opus keeps the goal in view past the point where smaller models drift.",
      },
      {
        title: "Operator / planner roles",
        body: "Use Opus 4.7 as the planner that breaks a task into sub-steps and delegates each one to a Sonnet- or Haiku-tier sub-agent.",
      },
      {
        title: "Long-context document agents",
        body: "Analysis over 100K+ tokens of transcripts, contracts, or specs. Opus's 1M window holds the whole picture without losing earlier sections.",
      },
    ],
    avoidFor: [
      "High-volume routine work — Sonnet 4.6 hits the same quality bar at a fraction of the cost",
      "Latency-sensitive chat replies — Haiku 4.5 is much faster",
      "Bulk classification or extraction jobs — DeepSeek V4 Flash is 80× cheaper",
    ],

    comparisons: [
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet is the credit baseline (×1) and the right default for most agents. Promote to Opus 4.7 (×1.7) only when Sonnet visibly fails on hard reasoning, long context, or code edits — usually as the orchestrator, not for every step.",
      },
      {
        vs: "Claude Opus 4.6",
        body: "Same multiplier (×1.7) and same context window (1M tokens). Opus 4.7 is newer and stronger — pick 4.7 for new agents. Pin 4.6 only if a specific agent has been validated against that version and you need behaviour stability.",
      },
      {
        vs: "Kimi K2.6",
        body: "Kimi K2.6 (×0.3) leads on several agentic benchmarks (vendor-reported SWE-bench Pro 58.6 vs Opus 4.6's 53.4) and is reachable from China. Opus 4.7 still leads on tool-routing reliability for production English-language agents and on safety profile.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro (×0.3) trails Opus on most reasoning benchmarks but matches it on coding (SWE-bench Verified within ~0.2 pts, vendor-reported). Pick DeepSeek when cost dominates the decision; pick Opus 4.7 when reliability and safety matter more than per-call cost.",
      },
    ],

    verdict:
      "Opus 4.7 is the model you reach for when nothing else is good enough. It is the most expensive option in our Built-in lineup by a wide margin, so the rational pattern is: default to Sonnet 4.6, identify the specific failures that need more reasoning depth, and route only those calls to Opus 4.7.",

    faqs: [
      {
        q: "How much does Claude Opus 4.7 cost on VM0?",
        a: "Anthropic's list price is $5 per 1M input tokens and $25 per 1M output tokens. On VM0 Managed it bills at ×1.7 of Claude Sonnet 4.6. Cached input drops to $0.50 per 1M tokens.",
      },
      {
        q: "What is Claude Opus 4.7's context window?",
        a: "1 million tokens, with up to 64K tokens of output per response. The full window bills at standard rates — a 900K-token request is the same per-token rate as a 9K-token request.",
      },
      {
        q: "Can Claude Opus 4.7 handle images?",
        a: "Yes. Opus 4.7 is multimodal — it accepts image inputs alongside text and code, so screenshot-driven and document-vision agents work natively.",
      },
      {
        q: "Is Claude Opus 4.7 available in China?",
        a: "Anthropic's API endpoint is not directly reachable from mainland China. For China-region deployments choose Kimi K2.6, GLM-5.1, MiniMax M2.7, or DeepSeek V4 — all four are exposed to VM0 with Anthropic-compatible APIs.",
      },
      {
        q: "When should I pick Opus 4.7 over Sonnet 4.6?",
        a: "When (a) the agent is the planner / orchestrator and decisions cascade, (b) the run is long enough that Sonnet starts dropping instructions, or (c) the output must apply cleanly on the first attempt (code edits, structured payloads).",
      },
      {
        q: "Should I migrate from Opus 4.6 to Opus 4.7?",
        a: "Yes. Anthropic explicitly recommends 4.7 over 4.6 — same multiplier, stronger behaviour. Migrate pinned production agents only after running them through your regression suite.",
      },
      {
        q: "Does Opus 4.7 support prompt caching?",
        a: "Yes. Cached input bills at $0.50 per 1M tokens — a 10× discount on the cached portion. Worth using whenever your system prompt or tool schema is stable across calls.",
      },
    ],

    alternatives: [
      { slug: "claude-sonnet-4-6", reason: "Cheaper default for most agent loops" },
      { slug: "kimi-k2.6", reason: "Stronger long-context recall at lower cost" },
      { slug: "deepseek-v4-pro", reason: "Cost-optimised reasoning if Claude is overkill" },
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
      "Claude Opus 4.6 review on VM0 — Anthropic's previous flagship. SWE-bench Verified 80.8%, $5/$25 pricing, 1M context, and when to pin 4.6 instead of upgrading.",
    pageTitle: "Claude Opus 4.6 on VM0",
    tagline:
      "Anthropic's previous flagship. Same multiplier and 1M context as Opus 4.7 — keep it pinned only when an agent has been validated on this exact version.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    chinaAccessible: false,
    releasedToVm0: "Available since launch",

    cardIntro:
      "Anthropic's previous flagship. Same credit cost as Opus 4.7 — keep it pinned only if a specific agent has been validated against this version.",
    cardBestFor: [
      "Agents with frozen prompts that were tuned against Opus 4.6",
      "A/B comparing against Opus 4.7 on regression tests",
    ],
    cardAvoidFor: [
      "New agents — start with Opus 4.7 unless you have a reason to pin",
    ],

    summaryPoints: [
      "Anthropic's previous flagship — released February 5, 2026.",
      "Same ×1.7 multiplier and 1M context as Opus 4.7; same vendor pricing too.",
      "Pin 4.6 only when behaviour stability matters; otherwise upgrade.",
    ],

    releaseDate: "February 5, 2026",
    familyPosition:
      "Previous top-tier of the Claude 4 family — superseded by Claude Opus 4.7.",
    background: [
      "Claude Opus 4.6 was Anthropic's frontier model before Opus 4.7. It was released on February 5, 2026 and introduced several capabilities that defined the Claude 4 family — adaptive thinking with four effort levels, the 1M-token context window in beta, and Anthropic's highest agentic-coding scores at release.",
      "On VM0 it sits at the same ×1.7 credit multiplier as Opus 4.7. Anthropic explicitly recommends migrating to 4.7 for new work; pin 4.6 only if a specific agent has been validated against this version and you don't want to re-run regression tests yet.",
    ],

    architecture: [
      "Adaptive thinking — four effort levels (low / medium / high / max), high as default",
      "1M-token context window in beta at standard pricing",
      "Compaction API for server-side context summarisation",
      "Prefilling disabled (breaking change vs Opus 4.5) — use structured outputs instead",
      "Multi-agent / Mailbox Protocol for peer-to-peer agent teams",
      "`inference_geo` parameter for US-only inference at a 1.1× multiplier",
    ],

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "1M tokens (beta)" },
      { label: "Max output", value: "Up to 128K tokens" },
      { label: "Region", value: "Global; not directly reachable from China" },
      { label: "Available on VM0", value: "Available since launch" },
    ],

    benchmarks: [
      { name: "SWE-bench Verified", score: "80.8%", note: "vendor-reported" },
      { name: "Terminal-Bench 2.0", score: "65.4%", note: "vendor-reported" },
      { name: "OSWorld (computer use)", score: "72.7%", note: "vendor-reported" },
      { name: "MRCR v2 (1M, 8-needle)", score: "76%", note: "vendor-reported" },
      { name: "Artificial Analysis Intelligence Index", score: "53", note: "max effort" },
      { name: "Speed", score: "~41 tokens/sec", note: "Artificial Analysis" },
    ],
    benchmarksNote:
      "Vendor-reported scores from Anthropic's Opus 4.6 release materials and Artificial Analysis. Treat absolute SWE-bench numbers cautiously — OpenAI flagged training-data contamination on SWE-bench Verified across all frontier models.",

    pricing: {
      inputUsd: 15,
      outputUsd: 75,
      cacheReadUsd: 1.5,
      cacheWriteUsd: 18.75,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$1.13 in vendor list price ($0.75 input + $0.375 output) — three times Opus 4.7's vendor cost at the same multiplier.",

    performance: [
      {
        title: "Reasoning",
        body: "Strong on hard reasoning steps. Opus 4.7 is incrementally better at slightly lower vendor cost — there is no benchmark category where 4.6 leads.",
      },
      {
        title: "Tool use",
        body: "Reliable across multi-tool agent flows. Same ballpark as Sonnet 4.6 on routing accuracy with extra robustness on edge cases.",
      },
      {
        title: "Long context",
        body: "1M-token context with 76% MRCR v2 recall — actually usable across the full window, not just nominal.",
      },
      {
        title: "Speed",
        body: "Slower than Sonnet 4.6 and Haiku 4.5; comparable to Opus 4.7. Around 41 tokens/sec at max effort per Artificial Analysis.",
      },
    ],

    routingNotes:
      "Routed directly to Anthropic's Messages API. Available on VM0 Managed and as the default model on the Anthropic API-key and Claude Code OAuth providers.",
    vm0Notes: [
      "Highest vendor list price per token of any Built-in model.",
      "Prompt caching is supported; lean on it heavily to keep cost reasonable.",
      "Default model on the Anthropic and Claude Code OAuth providers — it's the model your team likely already has muscle memory for.",
    ],

    bestForExamples: [
      {
        title: "Pinned production agents",
        body: "Agents whose prompts and tool schemas were tuned and tested against Opus 4.6. Pin to keep behaviour stable until you re-validate on 4.7.",
      },
      {
        title: "Regression baseline",
        body: "Useful as the comparison model when evaluating whether to roll a fleet over to Opus 4.7 — same multiplier, easy to A/B at the agent level.",
      },
    ],
    avoidFor: [
      "New agents — start on Opus 4.7 unless you have a concrete reason",
      "Cost-sensitive workloads — same multiplier, higher vendor cost than 4.7",
    ],

    comparisons: [
      {
        vs: "Claude Opus 4.7",
        body: "Same ×1.7 multiplier and 1M context window. Opus 4.7 is newer, faster, and lower vendor list price. Pin 4.6 only when you've already invested in tuning against this version.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 is ×1 and handles most agent loops. Reach for Opus only when Sonnet visibly fails — usually for orchestration or hard code edits.",
      },
      {
        vs: "Kimi K2.6",
        body: "Kimi K2.6 (×0.3) edges Opus 4.6 on SWE-bench Pro (58.6 vs 53.4 vendor-reported) and is much cheaper. Opus 4.6 retains the safety-profile advantage and is the default Western enterprise pick.",
      },
    ],

    verdict:
      "Opus 4.6 is yesterday's flagship. If you have working production agents tuned on this version, keep them on 4.6 and migrate when you're ready. If you're starting new work, jump straight to Opus 4.7 — Anthropic recommends it and the migration is a setting change, not a rewrite.",

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
        q: "How much does Claude Opus 4.6 cost?",
        a: "$5 per 1M input tokens, $25 per 1M output tokens — same vendor pricing as Opus 4.5. Cached input is $0.50/M.",
      },
      {
        q: "Why is Opus 4.6 the default on the Anthropic API key provider?",
        a: "Historical default from before Opus 4.7 launched. You can switch any agent to Opus 4.7, Sonnet 4.6, or Haiku 4.5 in VM0 Settings → Model Providers without changing the API key.",
      },
      {
        q: "What's adaptive thinking?",
        a: "A scheduling layer that lets Claude decide how much reasoning compute to spend per turn. Four levels — low, medium, high, max — with high as the default. Replaced Opus 4.5's extended-thinking toggle.",
      },
    ],

    alternatives: [
      { slug: "claude-opus-4-7", reason: "Newer, lower vendor cost" },
      { slug: "claude-sonnet-4-6", reason: "Sonnet baseline at much lower cost" },
      { slug: "kimi-k2.6", reason: "Cheaper open-weight alternative on agentic benchmarks" },
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
    pageTitle: "Claude Sonnet 4.6 on VM0 — the default agent model",
    tagline:
      "The default for most VM0 agents. Strong tool routing, good long-context behaviour, and the credit baseline — every other model is priced relative to Sonnet 4.6.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    chinaAccessible: false,
    releasedToVm0: "Available since launch",

    cardIntro:
      "The default for most VM0 agents. Strong tool-routing accuracy, good long-context behaviour, and the credit baseline — every other model is priced relative to Sonnet 4.6.",
    cardBestFor: [
      "The default choice when you're not sure which model to pick",
      "Multi-tool agents that need reliable routing across Slack, GitHub, Linear, Notion",
      "Workflows where you want a stable cost baseline",
    ],
    cardAvoidFor: [
      "Tasks that demand maximum reasoning depth — escalate to Opus 4.7",
      "Very high-volume cheap tasks — drop to Haiku 4.5 or DeepSeek V4 Flash",
    ],

    summaryPoints: [
      "VM0's default model. Start here unless you have a reason not to.",
      "×1 credit baseline. $3/$15 per 1M tokens; cached input drops to $0.30/M.",
      "Strongest tool-routing accuracy at this price point in the lineup.",
    ],

    releaseDate: "February 2026 (Claude 4.6 generation)",
    familyPosition:
      "Mid-tier of the Claude 4 family — Anthropic's workhorse model, sitting between Haiku and Opus.",
    background: [
      "Claude Sonnet 4.6 sits in the middle of Anthropic's Claude 4 family. It is the workhorse model designed to handle the full breadth of typical agent work — multi-tool routing, code edits, long-running conversations, and structured-output tasks — without the cost premium of Opus.",
      "Across VM0's Built-in lineup, every other model's credit multiplier is normalised against Sonnet 4.6 (×1). That makes Sonnet the right pick when you want predictable budget conversations: “this agent runs at roughly 2× a Sonnet step” is a more useful sentence than absolute dollar quotes that move every quarter.",
      "Sonnet 4.6 supports Anthropic's prompt caching, which makes a big difference for VM0 agents that ship a stable system prompt and a fixed tool schema. Cached input tokens bill at $0.30 per 1M instead of $3 — a 10× saving on the parts of the prompt that don't change between turns.",
    ],

    architecture: [
      "1M-token context window at standard pricing",
      "Adaptive thinking inherited from Opus 4.6",
      "Prompt caching with 10× cached-input discount",
      "Multimodal — text, vision, code",
    ],

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "1M tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Region", value: "Global; not directly reachable from China" },
      { label: "Default for", value: "VM0 Managed" },
    ],

    benchmarks: [
      { name: "SWE-bench Verified", score: "~77%", note: "vendor-reported" },
      { name: "Long-context recall", score: "Strong across 100K+", note: "internal observation" },
      { name: "Tool routing", score: "Best in class at ×1", note: "VM0 internal" },
    ],
    benchmarksNote:
      "Sonnet 4.6 sits roughly 3–4 percentage points behind Opus 4.6 on Anthropic's headline coding benchmarks while being three to five times cheaper at the vendor level — the typical Opus/Sonnet trade-off.",

    pricing: {
      inputUsd: 3,
      outputUsd: 15,
      cacheReadUsd: 0.3,
      cacheWriteUsd: 3.75,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$0.225 in vendor list price ($0.15 input + $0.075 output). Cached input cuts the input portion to ~$0.015.",

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
        body: "Faster than Opus and slower than Haiku — the right speed/quality balance for production agents.",
      },
      {
        title: "Cost predictability",
        body: "Pricing is the credit baseline; prompt caching makes the on-VM0 cost especially predictable for agents with fixed system prompts.",
      },
    ],

    routingNotes:
      "Routed directly to Anthropic's Messages API. Default model on VM0 Managed.",
    vm0Notes: [
      "Sonnet 4.6 is the credit baseline (×1) — every other Built-in model's multiplier is normalised against this one.",
      "First choice for new agents on VM0; only escalate to Opus when Sonnet underperforms a specific task.",
      "Native prompt caching pairs well with VM0's stable system prompts and tool definitions.",
    ],

    bestForExamples: [
      {
        title: "Day-to-day Slack agents",
        body: "Triage, follow-ups, status updates, search assistants. Sonnet's tool-routing accuracy keeps these reliable without the Opus tax.",
      },
      {
        title: "Code-aware engineering agents",
        body: "PR review, test scaffolding, refactor suggestions, bug bisection. Sonnet handles most of the work; promote to Opus 4.7 only for the hardest patches.",
      },
      {
        title: "Multi-tool research agents",
        body: "GitHub + Linear + Notion + the web. Sonnet stays on goal across 20+ tool turns at a fraction of Opus's cost.",
      },
      {
        title: "Customer-support assistants",
        body: "Long conversation histories, frequent tool calls into a CRM. Cached system prompts keep cost flat.",
      },
    ],
    avoidFor: [
      "Hardest reasoning steps where Sonnet visibly drops instructions — escalate to Opus 4.7",
      "Bulk classification at high volume — DeepSeek V4 Flash is 50× cheaper",
      "Latency-critical micro-replies — Haiku 4.5 is faster",
    ],

    comparisons: [
      {
        vs: "Claude Opus 4.7",
        body: "Sonnet 4.6 is ×1; Opus 4.7 is ×1.7. Sonnet handles most agents; Opus is the upgrade when reasoning depth matters more than throughput. Many teams use Opus as the planner and Sonnet as the worker.",
      },
      {
        vs: "Claude Haiku 4.5",
        body: "Haiku 4.5 is ×0.3 — three times cheaper than Sonnet. Sonnet leads on tool-routing accuracy and long-context coherence; Haiku wins on speed and cost. Use Haiku as a sub-agent or for high-volume simple flows.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro (×0.3) matches Sonnet on coding benchmarks (vendor-reported SWE-bench Verified) at much lower cost. The trade is some tool-routing reliability and a less-mature safety profile.",
      },
    ],

    verdict:
      "Sonnet 4.6 is the right default for almost every new VM0 agent. It is the credit baseline, the most reliable tool-router at its price, and a known quantity to migrate up from (Opus 4.7) or down from (Haiku 4.5, DeepSeek V4 Pro) once you've seen real production behaviour.",

    faqs: [
      {
        q: "How much does Claude Sonnet 4.6 cost on VM0?",
        a: "Anthropic's list price is $3 per 1M input tokens and $15 per 1M output tokens. On VM0 Managed it bills at the ×1 credit baseline. Cached input drops to $0.30 per 1M tokens.",
      },
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
        a: "Yes. It's multimodal — text, code, and images.",
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
      { slug: "claude-opus-4-7", reason: "Use when Sonnet hits its reasoning ceiling" },
      { slug: "claude-haiku-4-5", reason: "Cheaper sibling for routing and triage" },
      { slug: "deepseek-v4-pro", reason: "Far cheaper alternative at similar reasoning quality" },
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
      "GLM-5.1 review on VM0 — Z.AI's flagship with up to 1M-token context, China-region API, ×0.4 credit cost. Specs, pricing, performance and recommended agent tasks.",
    pageTitle: "GLM-5.1 on VM0 — long-context, China-friendly agents",
    tagline:
      "Z.AI's flagship. Up to a 1M-token context window and a China-region endpoint — strong for whole-codebase or whole-knowledge-base agents at well below Sonnet pricing.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    chinaAccessible: true,
    releasedToVm0: "April 2026",

    cardIntro:
      "Z.AI's flagship. Up to a 1M-token context window and a China-region endpoint — strong for whole-codebase or whole-knowledge-base agents at well below Sonnet pricing.",
    cardBestFor: [
      "Agents that consume an entire repository or document corpus in one run",
      "China-region deployments where Anthropic isn't reachable",
      "Cost-sensitive long-context jobs",
    ],
    cardAvoidFor: ["Highest-stakes reasoning — Sonnet 4.6 or Opus 4.7 is safer"],

    summaryPoints: [
      "Largest context window in the Built-in lineup — up to 1M tokens.",
      "×0.4 credit cost on VM0; reachable from mainland China without a proxy.",
      "Best pick for whole-repository or whole-knowledge-base agents.",
    ],

    releaseDate: "Early 2026; full GA on VM0 April 2026",
    familyPosition: "Z.AI / Zhipu AI's flagship general-purpose model.",
    background: [
      "GLM-5.1 is the flagship of Zhipu AI's GLM series, distributed via Z.AI. It's a Chinese-built reasoning model with strong general capability and an unusually large context window — up to 1M tokens, several times larger than the Anthropic and Moonshot defaults at the same price tier.",
      "On VM0, GLM-5.1 is exposed two ways: through VM0 Managed (routed via OpenRouter with the upstream id `z-ai/glm-5.1`), and via a direct Z.AI API key (where it's the default model). Either path uses Z.AI's Anthropic-compatible interface, so existing VM0 agents drop in unchanged.",
      "GLM-5.1 became broadly available on VM0 in April 2026 when its feature flag was retired (PR #10497). It's the cost-efficient long-context option in the lineup, sitting at ×0.4 credits — less than half of Sonnet 4.6.",
    ],

    architecture: [
      "Up to 1M-token context window — largest in the Built-in lineup",
      "Anthropic-compatible API surface (drop-in for Claude agents)",
      "Prompt caching supported on the upstream",
      "China-region endpoint at `api.z.ai`",
    ],

    specs: [
      { label: "Family", value: "GLM-5 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "Up to 1M tokens" },
      { label: "Prompt caching", value: "Supported (Anthropic-compatible)" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "April 2026" },
    ],

    benchmarks: [
      { name: "Code Arena", score: "Top-3 (open weights)", note: "third-party leaderboard" },
      { name: "Long-context recall", score: "Strong across 1M-token window", note: "vendor-reported" },
    ],
    benchmarksNote:
      "Independent reviews place GLM-5.1 in the top tier of open-weight models for Chinese-language and long-context tasks. Numbers shift weekly on third-party leaderboards — we deliberately don't pin exact percentages here.",

    pricing: {
      inputUsd: 1.4,
      outputUsd: 4.4,
      cacheReadUsd: 0.26,
      cacheWriteUsd: 1.4,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$0.092 in vendor list price ($0.07 input + $0.022 output) — under half the Sonnet 4.6 vendor cost.",

    performance: [
      {
        title: "Long-context recall",
        body: "GLM-5.1's 1M-token window is genuinely usable. It maintains coherence well past the 200K boundary that limits the Anthropic family on the older 200K models — useful for whole-repo or whole-doc-corpus agents.",
      },
      {
        title: "Reasoning",
        body: "Solid general reasoning, particularly strong on Chinese-language tasks. Below Sonnet 4.6 on the hardest English-language multi-tool routing, but the gap is small relative to the cost difference.",
      },
      {
        title: "Tool use",
        body: "Reliable across the common VM0 tool surface (Slack, GitHub, Notion, Linear). Some edge cases in deeply nested tool calls are handled less crisply than Claude Sonnet 4.6.",
      },
    ],

    routingNotes:
      "On VM0 Managed, GLM-5.1 is routed through OpenRouter with the upstream id `z-ai/glm-5.1`. With a Z.AI API key it talks to `api.z.ai`'s Anthropic-compatible endpoint directly. Default model on the Z.AI provider.",
    vm0Notes: [
      "VM0 sets a 50-minute API timeout for the Z.AI provider — long thinking steps complete reliably without dropping.",
      "1M-token context is the largest in the Built-in lineup; pair with high-volume document agents.",
      "Reachable from mainland China without a proxy — the cleanest China-region pick alongside Kimi.",
    ],
    vm0TimeoutMin: 50,

    bestForExamples: [
      {
        title: "Whole-repository code agents",
        body: "Stuff an entire mid-sized repo into a single GLM-5.1 prompt and ask for cross-file refactors or architectural reviews. The 1M-token window holds the whole picture.",
      },
      {
        title: "Knowledge-base research",
        body: "Long-form research over hundreds of documents — wikis, RFCs, contracts, support tickets. Cost stays manageable thanks to the ×0.4 multiplier.",
      },
      {
        title: "China-region general-purpose agents",
        body: "When your users and infrastructure are in China and Anthropic isn't reachable, GLM-5.1 is the strongest first choice in the lineup.",
      },
      {
        title: "Long-running thinking jobs",
        body: "Tasks that take 10+ minutes of model time. The 50-minute VM0 timeout makes GLM-5.1 the safe pick over models with shorter timeouts.",
      },
    ],
    avoidFor: [
      "Hardest English-language reasoning — Sonnet 4.6 or Opus 4.7 still leads",
      "Latency-critical chat replies — Haiku 4.5 is much faster",
    ],

    comparisons: [
      {
        vs: "Kimi K2.6",
        body: "Both are China-region long-context options at similar credit cost (×0.4 vs ×0.3). Kimi has stronger long-context recall in our internal evaluation; GLM-5.1 wins on raw context size (1M vs 256K). Pick Kimi for very long transcripts; pick GLM-5.1 when you need to stuff a whole codebase into one prompt.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 (×1) leads on tool-routing accuracy and English-language reasoning. GLM-5.1 (×0.4) leads on context window and is the right pick when cost or China-region access dominates the decision.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro (×0.3) is cheaper and benchmarks higher on Code Arena per third-party reviews. GLM-5.1 still wins on context size. Pick DeepSeek for cost-sensitive standard-context work; pick GLM-5.1 when context size is the constraint.",
      },
    ],

    verdict:
      "GLM-5.1 is the long-context specialist in our Built-in lineup. If you need 200K+ tokens in a single prompt — whole repositories, whole knowledge bases, multi-document research — this is the model. If you don't, DeepSeek V4 Pro is a cheaper general-purpose option and Sonnet 4.6 is a more reliable tool router.",

    faqs: [
      {
        q: "How big is GLM-5.1's context window on VM0?",
        a: "Up to 1 million tokens — the largest in our Built-in lineup. Enough to fit a mid-sized repository or several hundred documents in a single prompt.",
      },
      {
        q: "Is GLM-5.1 reachable from China?",
        a: "Yes. Z.AI's API endpoint is hosted in China and reachable without a proxy. VM0 routes the Z.AI provider directly to `api.z.ai`.",
      },
      {
        q: "How much does GLM-5.1 cost on VM0?",
        a: "Z.AI's list price is $1.40 per 1M input tokens and $4.40 per 1M output tokens. On VM0 Managed it bills at ×0.4 of Claude Sonnet 4.6.",
      },
      {
        q: "Which provider should I use for GLM-5.1?",
        a: "VM0 Managed is the simplest path. If you want vendor-direct billing or your traffic must stay inside China, connect a Z.AI API key.",
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
      { slug: "kimi-k2.6", reason: "Stronger long-context recall, China-friendly" },
      { slug: "deepseek-v4-pro", reason: "Cheaper Chinese model with shorter context" },
      { slug: "claude-sonnet-4-6", reason: "Stronger reasoning if cost isn't the constraint" },
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
      "Claude Haiku 4.5 review on VM0 — fast, cheap Claude with SWE-bench Verified 73.3%. ×0.3 multiplier, $1/$5 pricing, 97 tok/sec, ideal for triage and routing.",
    pageTitle: "Claude Haiku 4.5 on VM0 — fast, cheap routing",
    tagline:
      "The fast, cheap Claude. Good enough for routing, short summarisation, and simple tool calls at a fraction of Sonnet's cost.",

    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    chinaAccessible: false,
    releasedToVm0: "Available since launch",

    cardIntro:
      "The fast, cheap Claude. Good enough for routing, short summarisation, and simple tool calls at a fraction of Sonnet's cost.",
    cardBestFor: [
      "Slack triage, classification, and routing agents",
      "Per-message replies in chat threads where latency matters",
      "Sub-agents inside a larger Sonnet/Opus orchestrator",
    ],
    cardAvoidFor: [
      "Multi-step reasoning — Haiku will lose track on long agent loops",
    ],

    summaryPoints: [
      "Anthropic's small, fast Claude — three times cheaper than Sonnet 4.6.",
      "×0.3 credits on VM0; $1/$5 vendor pricing; ~97 tokens/sec.",
      "Vendor-reported SWE-bench Verified 73.3% — within 5pts of Sonnet at 1/3 the cost.",
    ],

    releaseDate: "Late 2025 (Claude 4.5 generation)",
    familyPosition:
      "Smallest tier of the Claude 4 family — Anthropic's high-throughput, low-latency option.",
    background: [
      "Claude Haiku 4.5 is the small, fast member of the Claude 4 family. It is built for latency-sensitive and high-volume work where Sonnet would be overkill — single-tool calls, fast classifications, short summarisations, and simple Slack replies.",
      "Haiku 4.5 is remarkably capable for its tier. Anthropic's vendor-reported SWE-bench Verified score is 73.3% — only ~4 points behind Sonnet 4.5 at one-third the cost. In Augment's agentic coding evaluation it reportedly hits 90% of Sonnet 4.5's performance, which puts it in genuine sub-agent territory.",
      "Despite being the small Claude, Haiku 4.5 is multimodal (vision-capable), supports prompt caching, and runs at ~97 tokens/sec — comfortably the fastest model in our Built-in lineup.",
    ],

    architecture: [
      "200K-token context window",
      "Multimodal — text, vision, code",
      "Prompt caching with 10× cached-input discount",
      "~97 tokens/sec output speed (4–5× faster than Sonnet 4.5)",
    ],

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "200K tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Region", value: "Global; not directly reachable from China" },
      { label: "Best for", value: "High-volume / latency-sensitive flows" },
    ],

    benchmarks: [
      { name: "SWE-bench Verified", score: "73.3%", note: "vendor-reported, 50-trial average" },
      { name: "SWE-bench Pro", score: "39.5%", note: "third-party (Scale AI)" },
      { name: "OSWorld (computer use)", score: "50.7%", note: "vendor-reported" },
      { name: "Speed", score: "~97 tokens/sec", note: "vendor-reported" },
    ],
    benchmarksNote:
      "Vendor-reported numbers from Anthropic's Haiku 4.5 launch materials. Note that OpenAI flagged training-data contamination on SWE-bench Verified across all frontier models — treat absolute numbers cautiously, but the relative ordering is robust.",

    pricing: {
      inputUsd: 1,
      outputUsd: 5,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 1.25,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$0.075 in vendor list price ($0.05 input + $0.025 output). Cached input cuts the input portion to ~$0.005.",

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
    vm0Notes: [
      "Lowest Claude multiplier (×0.3) makes it the right pick for high-volume routing workloads.",
      "Prompt caching keeps cost down on repeated short prompts.",
      "Doesn't carry the multi-step agent quality of Sonnet — keep loops short.",
    ],

    bestForExamples: [
      {
        title: "Slack triage agents",
        body: "Classify incoming Slack messages, route them to the right channel, send acknowledgments. Haiku is fast enough to feel real-time.",
      },
      {
        title: "Sub-agents under Sonnet/Opus",
        body: "An orchestrator picks the strategy with Sonnet or Opus, then delegates the cheap, narrow steps to Haiku sub-agents.",
      },
      {
        title: "High-volume classification & extraction",
        body: "Tag tickets, extract structured fields from emails, route forms. Haiku at ×0.3 with cached system prompts keeps unit cost negligible.",
      },
      {
        title: "Vision micro-tasks",
        body: "OCR a screenshot, identify a chart type, pull a value from an image. Haiku 4.5 is multimodal and very fast.",
      },
    ],
    avoidFor: [
      "Long multi-step agent loops — Haiku drops instructions after several turns",
      "Hard reasoning or code edits — Sonnet 4.6 or Opus 4.7 is the right call",
    ],

    comparisons: [
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet (×1) is the default for full agents. Haiku (×0.3) is the right pick when speed and cost matter more than long-loop coherence — typically as a worker under a Sonnet/Opus planner. Vendor benchmarks put Haiku within ~4 points of Sonnet 4.5 on SWE-bench Verified.",
      },
      {
        vs: "DeepSeek V4 Flash",
        body: "DeepSeek V4 Flash (×0.02) is much cheaper but with weaker tool-use and less reliable on multi-step loops. Use Flash for one-shot bulk work; use Haiku for short interactive Slack-style replies.",
      },
      {
        vs: "MiniMax M2.7",
        body: "MiniMax M2.7 (×0.1) is cheaper and stronger on Chinese-language tasks. Haiku 4.5 leads on English-language tool-routing reliability and is multimodal.",
      },
    ],

    verdict:
      "Haiku 4.5 is the Claude you put behind a heavy load. It is the right pick for triage, classification, and the sub-agent layer of a multi-tier agent system. Don't ask it to plan or orchestrate — that's Sonnet's job.",

    faqs: [
      {
        q: "How much does Claude Haiku 4.5 cost on VM0?",
        a: "Anthropic's list price is $1 per 1M input tokens and $5 per 1M output tokens. On VM0 Managed it bills at ×0.3 of Claude Sonnet 4.6. Cached input drops to $0.10 per 1M tokens.",
      },
      {
        q: "Is Haiku 4.5 multimodal?",
        a: "Yes. Haiku 4.5 accepts image inputs alongside text and code, so vision-driven agents work natively.",
      },
      {
        q: "How fast is Haiku 4.5?",
        a: "Anthropic reports ~97 tokens per second — 4 to 5 times faster than Sonnet 4.5. The fastest model in our Built-in lineup.",
      },
      {
        q: "When should I pick Haiku over Sonnet?",
        a: "Pick Haiku when (a) the agent loop is short — usually under 5 turns, (b) latency matters more than reasoning depth, or (c) you need a cheap sub-agent under a Sonnet/Opus orchestrator.",
      },
      {
        q: "Can Haiku run multi-tool agents?",
        a: "It can, but accuracy drops on edge cases compared to Sonnet 4.6. Keep the tool surface narrow and the loop short, or fall back to Sonnet.",
      },
      {
        q: "What's Haiku 4.5's SWE-bench score?",
        a: "Anthropic reports 73.3% on SWE-bench Verified — within ~4 points of Sonnet 4.5 at one-third the cost. On the harder SWE-bench Pro it scores 39.5% (Scale AI).",
      },
    ],

    alternatives: [
      { slug: "claude-sonnet-4-6", reason: "Step up when routing fidelity matters" },
      { slug: "deepseek-v4-flash", reason: "Even cheaper for single-shot tasks" },
      { slug: "minimax-m2.7", reason: "Cheap multilingual alternative for China-region work" },
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
      "Kimi K2.6 review on VM0 — Moonshot's open-weight 1T-parameter MoE. SWE-bench Pro 58.6, ×0.3 credit cost, China-accessible, 256K context. Specs and recommended tasks.",
    pageTitle: "Kimi K2.6 on VM0 — long-context China-region agents",
    tagline:
      "Moonshot's latest open-weight model. Best-in-class agentic benchmarks at the open-source frontier, China-region API, and a Claude-compatible interface.",

    contextWindowK: 256,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    chinaAccessible: true,
    releasedToVm0: "April 2026",

    cardIntro:
      "Moonshot's latest. Best-in-class long-context recall in our internal evaluation, China-region API, and a Claude-compatible interface.",
    cardBestFor: [
      "Long agent transcripts that exceed 200k tokens",
      "China-region agents that need a strong reasoner",
      "Research-style tasks with large supporting documents",
    ],
    cardAvoidFor: [
      "Multi-tool routing accuracy edge cases — Sonnet 4.6 still leads",
    ],

    summaryPoints: [
      "Moonshot's latest Kimi — leading open-weight model on several agentic benchmarks.",
      "×0.3 credit cost; reachable from mainland China without a proxy.",
      "Vendor-reported SWE-bench Pro 58.6 — beats GPT-5.4 (xhigh) and Claude Opus 4.6 (max).",
    ],

    releaseDate: "April 20, 2026",
    familyPosition:
      "Top of Moonshot's open-weight Kimi K2 series — successor to K2.5 and K2 Thinking.",
    background: [
      "Kimi K2.6 is Moonshot AI's open-weight agentic model released April 20, 2026. It's a 1-trillion-parameter Mixture-of-Experts (MoE) model with 32B active parameters per token — the same architecture family as K2.5 and K2 Thinking, with substantial gains on agentic coding and long-horizon reasoning.",
      "K2.6 made a real splash on independent leaderboards. Vendor-reported scores put it ahead of GPT-5.4 (xhigh) and Claude Opus 4.6 (max effort) on SWE-bench Pro, with a hallucination rate of 39% (down from K2.5's 65%). Artificial Analysis ranks it #4 on its Intelligence Index — the leading open-weight option.",
      "On VM0 it's exposed via the Moonshot API key as the default model, through VM0 Managed at the same ×0.3 multiplier, and via OpenRouter. The API is Anthropic-compatible, so VM0 agents written for Claude work without code changes.",
    ],

    architecture: [
      "Mixture-of-Experts — 1T total parameters, 32B active per token",
      "256K-token context window",
      "Multimodal — image and video input, text output",
      "Agent Swarm — scales horizontally to 300 sub-agents and 4,000 coordinated steps",
      "Long-horizon coding — 12+ hour autonomous sessions documented",
      "Modified MIT License — open weights on Hugging Face",
    ],

    specs: [
      { label: "Family", value: "Kimi K2 series" },
      { label: "Parameters", value: "1T total / 32B active (MoE)" },
      { label: "Modalities", value: "Image, video, text" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "256K tokens" },
      { label: "License", value: "Modified MIT (open weights)" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "April 2026" },
    ],

    benchmarks: [
      { name: "SWE-bench Pro", score: "58.6", note: "vendor-reported; beats GPT-5.4, Opus 4.6" },
      { name: "SWE-bench Verified", score: "80.2", note: "vendor-reported" },
      { name: "Terminal-Bench 2.0", score: "66.7", note: "Terminus-2 framework" },
      { name: "LiveCodeBench (v6)", score: "89.6", note: "vendor-reported" },
      { name: "HLE (with tools)", score: "54.0", note: "leads GPT-5.4 and Opus 4.6" },
      { name: "BrowseComp (Agent Swarm)", score: "86.3", note: "up from K2.5's 78.4" },
      { name: "Artificial Analysis Intelligence Index", score: "54", note: "#4 overall, leading open-weight" },
    ],
    benchmarksNote:
      "Vendor-reported scores from Moonshot's K2.6 release blog. Independent third parties (Artificial Analysis, TokenMix) corroborate the relative ordering. K2.6's hallucination rate dropped to 39% from K2.5's 65% — a significant safety/reliability improvement.",

    pricing: {
      inputUsd: 0.6,
      outputUsd: 3,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0.6,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$0.045 in vendor list price ($0.03 input + $0.015 output) — about a fifth of Sonnet 4.6's vendor cost.",

    performance: [
      {
        title: "Long-context recall",
        body: "Strongest long-context recall in our internal evaluation across the Built-in lineup. Maintains coherence across long agent transcripts where Anthropic Sonnet starts to drift.",
      },
      {
        title: "Agentic benchmarks",
        body: "Vendor-reported SWE-bench Pro 58.6 is the highest in the lineup at the time of writing — beats GPT-5.4 and Opus 4.6.",
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
    vm0Notes: [
      "Strongest long-context recall in the Built-in lineup based on our internal evaluation.",
      "Cheap enough (×0.3) to be a viable Sonnet substitute for cost-sensitive Chinese-region work.",
      "Reachable from mainland China without a proxy.",
    ],

    bestForExamples: [
      {
        title: "Long-transcript research agents",
        body: "Long Slack-thread investigation, support-ticket archaeology, multi-document research. K2.6's recall holds up where smaller models drop earlier turns.",
      },
      {
        title: "China-region general-purpose agents",
        body: "Default reasoner for agents serving Chinese-region users when Anthropic isn't reachable. The Claude-compatible API means migration is a setting change, not a rewrite.",
      },
      {
        title: "Long-horizon coding agents",
        body: "Refactor projects that run for hours. Moonshot's vendor materials document a 13-hour autonomous refactor of an 8-year-old matching engine.",
      },
      {
        title: "Multimodal agents",
        body: "K2.6 accepts image and video input — useful for document/screenshot agents in China-region deployments.",
      },
    ],
    avoidFor: [
      "Hardest tool-routing edge cases — Sonnet 4.6 leads on production reliability",
      "Latency-critical chat replies — Haiku 4.5 is faster",
    ],

    comparisons: [
      {
        vs: "GLM-5.1",
        body: "Both are China-region long-context options. K2.6 wins on raw long-context recall in our internal evaluation; GLM-5.1 wins on context size (1M vs 256K). Default to K2.6 for long transcripts; reach for GLM-5.1 only when you need >256K tokens in a single prompt.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet (×1) leads on multi-tool English-language routing reliability. K2.6 (×0.3) wins on cost, on Chinese-language work, on agentic benchmarks (SWE-bench Pro), and on China-region access. Pair them: Sonnet for global users, K2.6 for China.",
      },
      {
        vs: "Kimi K2.5",
        body: "K2.6 is the newer generation with stronger tool-use, lower hallucination rate (39% vs 65%), and better reasoning. K2.5 (×0.2) is slightly cheaper. Prefer K2.6 for new work.",
      },
    ],

    verdict:
      "K2.6 is now the open-weight default for serious agent work — particularly anything long-context, anything Chinese-language, anything China-region. On agentic benchmarks it has caught the closed-source frontier. The remaining gaps versus Claude Sonnet 4.6 are on tool-routing reliability and Western enterprise support; for everything else, K2.6 is competitive.",

    faqs: [
      {
        q: "When was Kimi K2.6 released?",
        a: "Moonshot AI released Kimi K2.6 on April 20, 2026. Open weights are published on Hugging Face under a Modified MIT License.",
      },
      {
        q: "How much does Kimi K2.6 cost on VM0?",
        a: "Moonshot's first-party API list price is $0.60 per 1M input tokens and $3 per 1M output tokens. On VM0 Managed it bills at ×0.3 of Claude Sonnet 4.6.",
      },
      {
        q: "Is Kimi K2.6 reachable from China?",
        a: "Yes. Moonshot's API is hosted in China and reachable without a proxy. VM0 routes the Moonshot provider directly.",
      },
      {
        q: "What's the context window?",
        a: "256K tokens. K2.6 differentiates on recall quality at that size, not raw window size — recall starts to degrade past ~180K (similar to other 256K models).",
      },
      {
        q: "Do I need to rewrite my agent to use Kimi?",
        a: "No. Kimi K2.6 exposes an Anthropic-compatible API, so VM0 agents tuned for Claude work without code changes.",
      },
      {
        q: "How does Kimi K2.6 compare to Claude Opus 4.6?",
        a: "On agentic benchmarks (vendor-reported), K2.6 leads — SWE-bench Pro 58.6 vs Opus 4.6's 53.4, HLE with tools 54.0 vs 53.0. Opus 4.6 retains an edge on safety profile and English-language tool-routing reliability in production.",
      },
      {
        q: "Does K2.6 support image input?",
        a: "Yes. K2.6 accepts image and video input — text-only output. Multimodal agents work natively.",
      },
    ],

    alternatives: [
      { slug: "kimi-k2.5", reason: "Older generation, slightly cheaper multiplier" },
      { slug: "glm-5.1", reason: "Even longer context window (1M tokens)" },
      { slug: "deepseek-v4-pro", reason: "Cheaper Chinese model for cost-sensitive work" },
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
      "DeepSeek V4 Pro review on VM0 — open-weight 1.6T MoE with SWE-bench Verified 80.6%, ×0.3 credit cost, 1M context. Pricing, specs and Claude comparison.",
    pageTitle: "DeepSeek V4 Pro on VM0 — cost-optimised reasoning",
    tagline:
      "DeepSeek's flagship V4 reasoning model. Within 0.2 points of Claude Opus 4.6 on SWE-bench Verified at one-seventh the vendor cost — China-accessible, Claude-compatible API.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    chinaAccessible: true,
    releasedToVm0: "April 24, 2026",

    cardIntro:
      "DeepSeek's flagship. Strong reasoning at one-third of Sonnet's credit cost, China-accessible, Claude-compatible API.",
    cardBestFor: [
      "Cost-sensitive agents that still need solid multi-step reasoning",
      "High-volume background workers (summarisation, extraction, batch review)",
      "China-region deployments with a tight unit-cost budget",
    ],
    cardAvoidFor: [
      "Hardest tool-routing edge cases — Claude Sonnet 4.6 is more reliable",
    ],

    summaryPoints: [
      "Open-weight 1.6T MoE — within 0.2 points of Opus 4.6 on SWE-bench Verified.",
      "×0.3 credits on VM0; $1.74/$3.48 vendor pricing; cache writes are free.",
      "1M context, China-accessible, MIT-licensed open weights.",
    ],

    releaseDate: "April 24, 2026",
    familyPosition:
      "Reasoning variant of the DeepSeek V4 family — paired with V4 Flash for cost.",
    background: [
      "DeepSeek V4 Pro is the flagship of DeepSeek's V4 generation, released April 24, 2026 under the MIT License. It's an open-weight Mixture-of-Experts model with 1.6T total parameters and 49B active per token, paired with V4 Flash (284B / 13B active) for cost-sensitive work.",
      "Both V4 models share an identical feature set: 1M-token context window, 384K maximum output, three reasoning effort modes (standard, think, think-max), JSON output, tool calls, and FIM completion in non-think mode. The Pro model adds a hybrid attention architecture (Compressed Sparse Attention + Heavily Compressed Attention) for dramatically improved long-context efficiency — 27% of single-token inference FLOPs and 10% of KV cache vs DeepSeek V3.2 at 1M context.",
      "DeepSeek made waves through 2025 by delivering Anthropic-grade reasoning at a fraction of the price. V4 Pro continues that pattern: vendor-reported SWE-bench Verified 80.6% sits within 0.2 points of Claude Opus 4.6, at roughly one-seventh the vendor cost. On VM0 it's exposed via the DeepSeek API-key provider and on VM0 Managed at ×0.3 — the same multiplier as Claude Haiku 4.5 but with substantially stronger reasoning behaviour.",
    ],

    architecture: [
      "Mixture-of-Experts — 1.6T total / 49B active parameters",
      "Hybrid attention — Compressed Sparse Attention + Heavily Compressed Attention",
      "1M-token context window with 384K maximum output",
      "Three reasoning effort modes — standard / think / think-max",
      "Manifold-Constrained Hyper-Connections for stable signal propagation",
      "Trained on 32T+ tokens with the Muon optimizer",
      "MIT License — open weights",
    ],

    specs: [
      { label: "Family", value: "DeepSeek V4 series" },
      { label: "Parameters", value: "1.6T total / 49B active (MoE)" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "1M tokens" },
      { label: "Max output", value: "384K tokens" },
      { label: "License", value: "MIT (open weights)" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "April 24, 2026" },
    ],

    benchmarks: [
      { name: "SWE-bench Verified", score: "80.6%", note: "vendor-reported; within 0.2pts of Opus 4.6" },
      { name: "Terminal-Bench 2.0", score: "67.9%", note: "vendor-reported; leads Opus 4.6" },
      { name: "LiveCodeBench", score: "93.5%", note: "vendor-reported" },
      { name: "Codeforces rating", score: "3206", note: "vendor-reported" },
      { name: "MMLU-Pro", score: "Matches GPT-5.4", note: "vendor-reported" },
      { name: "Artificial Analysis Intelligence Index", score: "52", note: "max effort" },
      { name: "Speed", score: "~36 tokens/sec", note: "Artificial Analysis" },
    ],
    benchmarksNote:
      "Vendor-reported scores from DeepSeek's V4 Pro release. Independent reviews (Geeky Gadgets, Code Arena) place V4 Pro third on Code Arena behind GLM-5.1 and Kimi K2.6 — the strongest benchmark claims come from DeepSeek's own materials. Treat directionally rather than as absolute truth.",

    pricing: {
      inputUsd: 1.74,
      outputUsd: 3.48,
      cacheReadUsd: 0.145,
      cacheWriteUsd: null,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$0.105 in vendor list price ($0.087 input + $0.017 output). Cache writes don't add anything — only reads bill.",

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
        body: "Cache writes are free — unique among VM0's Built-in models. Stable system prompts and large pasted reference docs cost nothing extra to cache, only the read side bills.",
      },
      {
        title: "Speed",
        body: "Around 36 tokens/sec at max effort per Artificial Analysis — slower than Haiku, slightly slower than Opus 4.6.",
      },
    ],

    routingNotes:
      "Routed through DeepSeek's Anthropic-compatible endpoint at `api.deepseek.com`. Available on VM0 Managed and the DeepSeek provider.",
    vm0Notes: [
      "Cache reads are billed; cache writes are not — a cost win when system prompts are stable.",
      "VM0 sets a 10-minute API timeout and disables non-essential traffic for the DeepSeek provider.",
      "Strongest reasoning of any sub-Sonnet model in our lineup.",
    ],
    vm0TimeoutMin: 10,

    bestForExamples: [
      {
        title: "High-volume reasoning agents",
        body: "Bulk PR review, automated triage, batch document review. V4 Pro hits Sonnet-tier accuracy at a third of the cost.",
      },
      {
        title: "Background workers",
        body: "Scheduled jobs that summarise, extract, or score in bulk. Free cache writes mean the system-prompt cost is one-time.",
      },
      {
        title: "China-region cost-sensitive agents",
        body: "When users are in China and budget per run matters, V4 Pro is the default reasoner.",
      },
      {
        title: "Long-context coding",
        body: "1M-token window with hybrid attention — fits whole repositories at meaningful inference cost.",
      },
    ],
    avoidFor: [
      "Hardest tool-routing edge cases — Sonnet 4.6 leads",
      "Bulk single-shot work where reasoning isn't required — V4 Flash is 12× cheaper",
    ],

    comparisons: [
      {
        vs: "DeepSeek V4 Flash",
        body: "Same vendor, different positioning. V4 Pro (×0.3) gives you reasoning; V4 Flash (×0.02) gives you the cheapest possible single-shot model. Vendor-reported SWE-bench Verified shows Flash within 1.6 points of Pro (79.0 vs 80.6) — but Pro pulls ahead on Terminal-Bench (67.9 vs 56.9) on multi-step tool use.",
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
      "V4 Pro is the “Claude at one-seventh the price” story. Independent reviewers caveat that DeepSeek's strongest claims come from DeepSeek's own materials — but even discounted, the cost-quality trade is real. The right pattern: pre-filter with V4 Flash, escalate to V4 Pro for reasoning, escalate to Sonnet 4.6 only when V4 Pro stalls on tool-routing edge cases.",

    faqs: [
      {
        q: "When was DeepSeek V4 Pro released?",
        a: "DeepSeek released V4 Pro and V4 Flash together on April 24, 2026 under the MIT License with open weights.",
      },
      {
        q: "How much does DeepSeek V4 Pro cost on VM0?",
        a: "DeepSeek's list price is $1.74 per 1M input tokens and $3.48 per 1M output tokens. On VM0 Managed it bills at ×0.3 of Claude Sonnet 4.6 — roughly one-seventh the cost of Claude Opus 4.7.",
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
        q: "Is V4 Pro reachable from China?",
        a: "Yes. DeepSeek's API is reachable from mainland China without a proxy.",
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
      "Kimi K2.5 review on VM0 — Moonshot's previous flagship at ×0.2 credit cost. SWE-bench Pro 50.7, 256K context, China-accessible. When to pin K2.5 instead of K2.6.",
    pageTitle: "Kimi K2.5 on VM0 — Moonshot's previous generation",
    tagline:
      "The previous Kimi generation. Cheaper than K2.6 but with weaker tool-use; pin it only if a specific agent was validated on this version.",

    contextWindowK: 256,
    promptCaching: true,
    modalities: ["Text", "Code"],
    chinaAccessible: true,
    releasedToVm0: "Available since launch",

    cardIntro:
      "The previous Kimi generation. Cheaper than K2.6 but with weaker tool-use; pin it only if a specific agent was validated on this version.",
    cardBestFor: [
      "Long-context summarisation jobs where K2.6's edge isn't worth the credits",
      "Pinned legacy agents already tuned on K2.5",
    ],
    cardAvoidFor: ["New agents — start with K2.6 unless you have a reason to pin"],

    summaryPoints: [
      "Moonshot's previous flagship — strong long-context, weaker tool-use than K2.6.",
      "×0.2 credit cost; same vendor list price as K2.6.",
      "Vendor-reported SWE-bench Pro 50.7 (vs K2.6's 58.6) — pin only when behaviour stability matters.",
    ],

    releaseDate: "Late 2025 (Kimi K2 series)",
    familyPosition:
      "Previous generation of Moonshot's open-weight Kimi K2 series — superseded by K2.6.",
    background: [
      "Kimi K2.5 was Moonshot's flagship Kimi model before K2.6. It was the first widely-deployed Kimi to combine long-context reasoning with a Claude-compatible API surface, and it remains a capable model for long-context summarisation work.",
      "On VM0 it sits at the same vendor list price as K2.6 but a lower credit multiplier (×0.2). The lower multiplier reflects positioning rather than raw token cost — K2.6 is the recommended default for new work; K2.5 is the legacy pin.",
      "K2.5 has a vendor-reported SWE-bench Pro score of 50.7 and a hallucination rate of ~65% — both meaningfully behind K2.6 (58.6 and 39%). Behaviourally it remains stable for pinned production agents.",
    ],

    architecture: [
      "Mixture-of-Experts — 1T total / 32B active parameters (same family as K2.6)",
      "256K-token context window",
      "Anthropic-compatible API surface",
      "Open weights on Hugging Face",
    ],

    specs: [
      { label: "Family", value: "Kimi K2 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "256K tokens" },
      { label: "License", value: "Modified MIT (open weights)" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "Available since launch" },
    ],

    benchmarks: [
      { name: "SWE-bench Pro", score: "50.7", note: "vendor-reported" },
      { name: "BrowseComp", score: "78.4", note: "vendor-reported" },
      { name: "Hallucination rate", score: "~65%", note: "down to 39% in K2.6" },
    ],
    benchmarksNote:
      "K2.5's benchmarks are now most useful as the comparison baseline for K2.6. The newer model leads on every published metric at the same vendor cost.",

    pricing: {
      inputUsd: 0.6,
      outputUsd: 3,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0.6,
    },
    vm0CostExample:
      "Same vendor pricing as K2.6 (~$0.045 per 50K-input / 5K-output step) but billed at ×0.2 on VM0 Managed instead of ×0.3.",

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
        body: "Vendor-reported hallucination rate of ~65% — much higher than K2.6's 39%. Expect more confident-but-wrong outputs.",
      },
    ],

    routingNotes:
      "Routed through Moonshot's Anthropic-compatible endpoint at `api.moonshot.ai`. Available on VM0 Managed, Moonshot, OpenRouter, and Vercel AI Gateway.",
    vm0Notes: [
      "Same per-token price as K2.6 but a lower multiplier (×0.2 vs ×0.3) — the multiplier reflects positioning, not raw cost.",
      "Solid long-context behaviour but K2.6 is the recommended choice for new work.",
    ],

    bestForExamples: [
      {
        title: "Pinned legacy agents",
        body: "Agents tuned and tested on K2.5 where you don't want to revalidate yet.",
      },
      {
        title: "Cheap long-context summarisation",
        body: "Bulk summarisation over 100K+ token transcripts where K2.6's tool-use edge isn't relevant.",
      },
    ],
    avoidFor: [
      "New agents — K2.6 is a free upgrade in every meaningful way except multiplier",
      "Multi-tool English routing — Sonnet 4.6 leads",
      "Tasks where hallucination is costly — K2.5's rate is materially worse than K2.6",
    ],

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
      "K2.5 is a maintenance-mode pick. If your team has agents pinned on this version, keep them stable until you've validated K2.6 — the upgrade is worthwhile but not urgent. For everything new, jump straight to K2.6.",

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
        a: "Vendor-reported ~65% — meaningfully higher than K2.6 (39%). If your agent reports facts to users, this matters; consider K2.6 instead.",
      },
      {
        q: "Is K2.5 reachable from China?",
        a: "Yes. Same Moonshot API endpoint as K2.6.",
      },
      {
        q: "What's K2.5's context window?",
        a: "256K tokens — same as K2.6.",
      },
    ],

    alternatives: [
      { slug: "kimi-k2.6", reason: "Newer Kimi with better tool-use" },
      { slug: "glm-5.1", reason: "Larger context window if you need it" },
      { slug: "deepseek-v4-pro", reason: "Stronger reasoning at slightly higher multiplier" },
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
      "MiniMax M2.7 review on VM0 — strong Chinese-language and multilingual reasoning at ×0.1 credit cost, 50-min API timeout, China-region endpoint. Pricing and tasks.",
    pageTitle: "MiniMax M2.7 on VM0 — multilingual at ×0.1",
    tagline:
      "Strong Chinese-language and multilingual reasoning at one-tenth of Sonnet's credit cost. China-region API, generous timeout for long thinking steps.",

    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Code"],
    chinaAccessible: true,
    releasedToVm0: "Available since launch",

    cardIntro:
      "Strong Chinese-language and multilingual reasoning at one-tenth of Sonnet's credit cost. China-region API, generous timeout for long thinking steps.",
    cardBestFor: [
      "Chinese-language agents (writing, summarisation, customer-facing)",
      "Multilingual workflows where English isn't the primary language",
      "Cheap, latency-tolerant background workers",
    ],
    cardAvoidFor: ["English-first multi-tool agents — Sonnet 4.6 is more reliable"],

    summaryPoints: [
      "Strong on Chinese-language and multilingual workloads at ×0.1.",
      "China-region endpoint with a 50-minute VM0 timeout for long thinking steps.",
      "Cheap background-worker default for Chinese-language production agents.",
    ],

    releaseDate: "Available since the M2 series launch",
    familyPosition:
      "Latest text reasoning model in MiniMax's M2 series.",
    background: [
      "MiniMax M2.7 is from MiniMax — a Chinese AI lab with a multilingual and multimodal product line. The text reasoning side is what's exposed on VM0; MiniMax's image and voice products are separate offerings on the lab's platform.",
      "On VM0, M2.7 is the default model on the MiniMax API-key provider. The Built-in lineup carries it at ×0.1 — one of the lowest multipliers in the catalogue — making it the default cheap-but-credible reasoner for Chinese-language workloads.",
      "VM0's MiniMax provider sets a 50-minute API timeout and disables non-essential traffic, so long thinking steps complete reliably without dropping connections.",
    ],

    architecture: [
      "Anthropic-compatible API surface",
      "200K-token context window",
      "Chinese-first multilingual training",
      "China-region endpoint at `api.minimax.io`",
    ],

    specs: [
      { label: "Family", value: "MiniMax M2 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese, multilingual" },
      { label: "Context window", value: "200K tokens" },
      { label: "Prompt caching", value: "Supported (Anthropic-compatible)" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "Available since launch" },
    ],

    benchmarks: [
      { name: "Chinese-language tasks", score: "Strong", note: "VM0 internal" },
      { name: "English multi-tool routing", score: "Below Sonnet 4.6", note: "VM0 internal" },
    ],
    benchmarksNote:
      "MiniMax publishes fewer head-to-head benchmark numbers than Anthropic, Moonshot, or DeepSeek. We've kept this section honest — pick M2.7 based on language profile and cost positioning rather than chasing leaderboards.",

    pricing: {
      inputUsd: 0.3,
      outputUsd: 1.2,
      cacheReadUsd: 0.06,
      cacheWriteUsd: 0.375,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$0.021 in vendor list price ($0.015 input + $0.006 output) — under a tenth of Sonnet 4.6's vendor cost.",

    performance: [
      {
        title: "Multilingual",
        body: "Stronger on Chinese and multilingual flows than the Anthropic family. The natural pick when the agent's primary language isn't English.",
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
    vm0Notes: [
      "VM0 sets a 50-minute API timeout and disables non-essential traffic for the MiniMax provider — long thinking steps survive without dropping.",
      "Lowest non-Flash multiplier — pair with high-volume Chinese-language workloads.",
    ],
    vm0TimeoutMin: 50,

    bestForExamples: [
      {
        title: "Chinese-language customer agents",
        body: "Reply drafting, ticket triage, multilingual chat. M2.7's language strength shows up here.",
      },
      {
        title: "Latency-tolerant background workers",
        body: "Overnight or scheduled summarisation and extraction jobs in Chinese-language corpora. ×0.1 keeps unit cost negligible.",
      },
      {
        title: "Long thinking jobs",
        body: "Multi-step reasoning that benefits from a long timeout window. The 50-minute VM0 timeout matches MiniMax's strength on extended thinking.",
      },
    ],
    avoidFor: [
      "English-first multi-tool agents — Sonnet 4.6 is more reliable",
      "Latency-critical replies — Haiku 4.5 is faster",
    ],

    comparisons: [
      {
        vs: "Kimi K2.6",
        body: "Kimi K2.6 (×0.3) has stronger reasoning and tool-use. M2.7 (×0.1) is one-third the cost and has a stronger multilingual profile. Default to Kimi for general work; reach for MiniMax for cheap Chinese-language background jobs.",
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
      "M2.7 is a positioning play, not a benchmark winner. It's the cheap multilingual default in our lineup, and the 50-minute timeout makes it safer than V4 Flash for thinking-heavy work. Use it where the job's language profile and budget call for it; reach for Kimi K2.6 or Sonnet 4.6 when raw quality matters.",

    faqs: [
      {
        q: "How much does MiniMax M2.7 cost on VM0?",
        a: "MiniMax's list price is $0.30 per 1M input tokens and $1.20 per 1M output tokens. On VM0 Managed it bills at ×0.1 of Claude Sonnet 4.6.",
      },
      {
        q: "What's the API timeout?",
        a: "VM0 sets a 50-minute timeout for the MiniMax provider, plus a flag to suppress non-essential traffic — long thinking steps complete reliably.",
      },
      {
        q: "Is M2.7 reachable from China?",
        a: "Yes. MiniMax's API is hosted in China and reachable without a proxy.",
      },
      {
        q: "Does MiniMax M2.7 support image input?",
        a: "M2.7 on VM0 is the text reasoning model. MiniMax sells multimodal products separately; image and voice generation aren't part of the VM0 Built-in agent surface today.",
      },
      {
        q: "Why is the multiplier so low (×0.1)?",
        a: "Vendor list price is genuinely low ($0.30/$1.20 per 1M) and VM0 prices the model accordingly. Use it as a cheap Chinese-language workhorse, not a reasoning replacement for Sonnet.",
      },
    ],

    alternatives: [
      { slug: "kimi-k2.6", reason: "Stronger reasoning at a similar price" },
      { slug: "deepseek-v4-flash", reason: "Even cheaper if quality permits" },
      { slug: "claude-haiku-4-5", reason: "Anthropic alternative for fast triage" },
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
      "DeepSeek V4 Flash review on VM0 — the cheapest Built-in model at ×0.02 credit cost ($0.14/$0.28). Vendor-reported SWE-bench Verified 79%, 1M context. Use cases.",
    pageTitle: "DeepSeek V4 Flash on VM0 — the cheapest model",
    tagline:
      "The cheapest model in the lineup — 50× less than Sonnet 4.6. Surprisingly capable for its tier — vendor-reported SWE-bench Verified within 1.6 points of V4 Pro.",

    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    chinaAccessible: true,
    releasedToVm0: "April 24, 2026",

    cardIntro:
      "The cheapest model in the lineup — 50× less than Sonnet 4.6. Good for high-volume single-shot tasks where the prompt does most of the work.",
    cardBestFor: [
      "Bulk classification, tagging, and extraction jobs",
      "Pre-filters before handing the hard cases to a larger model",
      "Anywhere unit cost dominates the decision",
    ],
    cardAvoidFor: [
      "Multi-step agent loops — V4 Flash will drift on long tool chains",
    ],

    summaryPoints: [
      "Cheapest Built-in model — 50× less than Claude Sonnet 4.6.",
      "×0.02 credits on VM0; $0.14/$0.28 vendor pricing; cache writes are free.",
      "Vendor-reported SWE-bench Verified 79.0% — within 1.6 points of V4 Pro.",
    ],

    releaseDate: "April 24, 2026",
    familyPosition:
      "Cost-leader of DeepSeek's V4 family — paired with V4 Pro for reasoning.",
    background: [
      "DeepSeek V4 Flash is the cost-leader in DeepSeek's V4 generation, released April 24, 2026 alongside V4 Pro. Where V4 Pro is positioned for reasoning, Flash is positioned for the absolute lowest unit cost — a model you can run at very high volumes without thinking about budget.",
      "Flash is a 284B-parameter MoE with 13B active per token (vs Pro's 1.6T / 49B). Both share the V4 family's identical feature set: 1M-token context, 384K maximum output, three reasoning effort modes, JSON output, and tool calls.",
      "On VM0 it carries a ×0.02 credit multiplier — the lowest in the entire Built-in catalogue. That makes it the default for bulk classification, tagging, extraction, and pre-filter workloads where the prompt does most of the work and the model just needs to follow instructions reliably. It shares the V4 family's free cache-write economics: only cache reads bill.",
    ],

    architecture: [
      "Mixture-of-Experts — 284B total / 13B active parameters",
      "1M-token context window with 384K maximum output",
      "Three reasoning effort modes — standard / think / think-max",
      "Free cache writes — only reads bill",
      "MIT License — open weights",
    ],

    specs: [
      { label: "Family", value: "DeepSeek V4 series" },
      { label: "Parameters", value: "284B total / 13B active (MoE)" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "1M tokens" },
      { label: "Max output", value: "384K tokens" },
      { label: "License", value: "MIT (open weights)" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "April 24, 2026" },
    ],

    benchmarks: [
      { name: "SWE-bench Verified", score: "79.0%", note: "vendor-reported; within 1.6pts of V4 Pro" },
      { name: "Terminal-Bench 2.0", score: "56.9%", note: "vendor-reported; trails V4 Pro by 11pts" },
      { name: "SimpleQA-Verified", score: "34.1%", note: "vendor-reported; trails V4 Pro" },
    ],
    benchmarksNote:
      "Vendor-reported scores from DeepSeek's V4 release. Flash matches Pro on simpler benchmarks but loses ground on multi-step tool use (Terminal-Bench) and factual recall (SimpleQA) — exactly what you'd expect from the smaller MoE.",

    pricing: {
      inputUsd: 0.14,
      outputUsd: 0.28,
      cacheReadUsd: 0.028,
      cacheWriteUsd: null,
    },
    vm0CostExample:
      "A 50K-input / 5K-output agent step costs ~$0.0084 in vendor list price ($0.007 input + $0.0014 output) — well under one cent per step.",

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
        body: "Vendor-reported Terminal-Bench 2.0 is 56.9% (vs V4 Pro's 67.9%) — meaningfully behind on complex multi-step tool flows. Don't put V4 Flash in a planner role.",
      },
      {
        title: "Context window",
        body: "1M tokens — same as V4 Pro and far larger than Anthropic Haiku (200K).",
      },
    ],

    routingNotes:
      "Routed through DeepSeek's Anthropic-compatible endpoint at `api.deepseek.com`. Default model on the DeepSeek provider; also available on VM0 Managed.",
    vm0Notes: [
      "Lowest credit multiplier of any Built-in model (×0.02) — 50× less than Sonnet 4.6.",
      "Cache reads are billed; cache writes are not.",
      "VM0 sets a 10-minute API timeout for the DeepSeek provider.",
    ],
    vm0TimeoutMin: 10,

    bestForExamples: [
      {
        title: "Bulk classification",
        body: "Tag tickets, route inbound forms, score reviews. ×0.02 makes per-record cost effectively zero.",
      },
      {
        title: "Pre-filter before a stronger model",
        body: "Run V4 Flash on every record; route the top 5% (or the unsure cases) to V4 Pro or Sonnet 4.6. Two-stage pipelines beat single-model pipelines on cost almost every time.",
      },
      {
        title: "Bulk extraction",
        body: "Pull structured fields from emails, PDFs, transcripts. Stable prompts plus free cache writes drive cost close to zero.",
      },
      {
        title: "Long-document one-shot answers",
        body: "1M context fits whole books or codebases for a single Q&A turn — at fractions of a cent per call.",
      },
    ],
    avoidFor: [
      "Multi-step agent loops — V4 Flash drifts on long tool chains",
      "Hard reasoning, code edits, or planner roles — V4 Pro or Sonnet 4.6 instead",
    ],

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
        body: "M2.7 (×0.1) is stronger on Chinese-language reasoning and has a 50-minute timeout for long thinking. V4 Flash (×0.02) is faster and far cheaper for single-shot work.",
      },
    ],

    verdict:
      "V4 Flash is a specialist tool. It is the cheapest model in the Built-in catalogue and the right answer when unit cost dominates a high-volume pipeline. Don't ask it to be a planner, don't put it in long agent loops — but for bulk tagging, extraction, and pre-filtering, nothing else competes on cost.",

    faqs: [
      {
        q: "When was DeepSeek V4 Flash released?",
        a: "DeepSeek released V4 Flash and V4 Pro together on April 24, 2026 under the MIT License with open weights.",
      },
      {
        q: "How much does DeepSeek V4 Flash cost on VM0?",
        a: "DeepSeek's list price is $0.14 per 1M input tokens and $0.28 per 1M output tokens. On VM0 Managed it bills at ×0.02 of Claude Sonnet 4.6 — the cheapest model in our catalogue.",
      },
      {
        q: "Should I run my entire agent on V4 Flash?",
        a: "Probably not. Flash is great at one-shot tasks but drifts on long multi-step loops (vendor-reported Terminal-Bench 2.0 is 11 points behind V4 Pro). The standard pattern is to use it as a pre-filter and escalate the hard cases to V4 Pro or Sonnet 4.6.",
      },
      {
        q: "Are cache writes really free?",
        a: "Yes — DeepSeek doesn't bill the cache-write portion. Only cache reads bill, at $0.028 per 1M tokens.",
      },
      {
        q: "Is V4 Flash reachable from China?",
        a: "Yes. DeepSeek's API is reachable from mainland China without a proxy.",
      },
      {
        q: "Is V4 Flash open-source?",
        a: "Yes. Weights are published under the MIT License (284B total / 13B active MoE). The hosted DeepSeek API is the production path for VM0.",
      },
      {
        q: "What's V4 Flash's context window?",
        a: "1 million tokens — identical to V4 Pro. Useful for long-document one-shot Q&A even at the cheapest tier.",
      },
    ],

    alternatives: [
      { slug: "deepseek-v4-pro", reason: "Same vendor, much stronger reasoning" },
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
