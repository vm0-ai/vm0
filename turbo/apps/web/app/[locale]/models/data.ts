// ---------------------------------------------------------------------------
// Models — Built-in lineup shown on /models and /models/[slug].
//
// Order, multipliers, pricing, and routing facts mirror the platform:
//   - turbo/packages/api-contracts/src/contracts/model-providers.ts
//     (VM0_MODEL_TO_PROVIDER, MODEL_PROVIDER_TYPES)
//   - turbo/apps/platform/.../settings/provider-ui-config.ts
//     (VM0_MODEL_CREDIT_MULTIPLIER)
//   - turbo/apps/web/scripts/dev-seed.ts (MODEL_PRICING — USD per 1M tokens)
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
  /** ≤ 60-char meta <title>. Lead with the model name. */
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
  /** Short intro shown on the list page card. */
  cardIntro: string;
  /** Bullets shown on the list page card. */
  cardBestFor: string[];
  cardAvoidFor: string[];

  // TL;DR
  /** 3 short bullets — answers "should I read this page?". */
  summaryPoints: string[];

  // Background
  /** 1–3 paragraphs about the model itself (vendor-neutral). */
  background: string[];

  // Specs
  specs: SpecRow[];

  // Pricing
  pricing: ModelPricing;
  /** Worked example string for VM0 Managed credit cost. */
  vm0CostExample: string;

  // Performance & benchmarks
  performance: PerformanceNote[];

  // VM0 routing
  routingNotes: string;
  vm0Notes: string[];
  vm0TimeoutMin?: number;

  // Best for
  bestForExamples: BestForExample[];
  /** When to pick something else. */
  avoidFor: string[];

  // Comparisons
  comparisons: ModelComparison[];

  // FAQ
  faqs: ModelFaq[];

  // Alternatives card row
  alternatives: { slug: string; reason: string }[];

  /** Provider configurations that default to this model. */
  defaultFor: string[];
}

// Helpers used to keep the data block compact.
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

    metaTitle:
      "Claude Opus 4.7: Pricing, Specs & Agent Tasks on VM0",
    metaDescription:
      "Claude Opus 4.7 on VM0 — Anthropic's strongest reasoning model. Pricing per 1M tokens, 200K context window, prompt caching support, and the agent tasks it handles best.",
    pageTitle: "Claude Opus 4.7 on VM0",
    tagline:
      "Anthropic's strongest reasoning model. The pick for the hardest agent steps when nothing else holds together — at the highest credit cost in the lineup.",

    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    chinaAccessible: false,
    releasedToVm0: "April 2026",

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
      "Highest reasoning quality of any model available on VM0 today.",
      "Most expensive option — ×1.7 credits, $5/M input and $25/M output.",
      "Use it as the orchestrator or for the hardest steps; route easy work to Sonnet 4.6 or Haiku 4.5.",
    ],

    background: [
      "Claude Opus 4.7 is the top-tier model in Anthropic's Claude 4 family. It is positioned as the “frontier” option for problems that require deep multi-step reasoning, careful planning, and dependable tool use — the kind of work where a slightly cheaper model will subtly compound errors over a long run.",
      "Compared to Sonnet 4.6, Opus invests more compute per token. The result is fewer dropped instructions on long agent loops, more reliable code patching, and stronger recall when the conversation history grows past 100K tokens. The tradeoff is the highest list price in the Built-in lineup.",
      "Opus 4.7 became available on VM0 in April 2026. It runs through Anthropic's standard Messages API with prompt caching enabled, so repeated system prompts and tool definitions don't pay the full input rate after the first call.",
    ],

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "200K tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Region", value: "Global; not directly reachable from China" },
      { label: "Available on VM0", value: "April 2026" },
    ],

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
        body: "On multi-tool agent benchmarks Opus 4.7 produces the lowest rate of mis-routed tool calls in our internal lineup — meaningfully better than Sonnet 4.6 on harder edge cases, much better than the sub-Sonnet tier.",
      },
      {
        title: "Long-context recall",
        body: "Coherent across 200K-token agent transcripts. Stays consistent on the goal even after dozens of tool turns and large pasted documents.",
      },
      {
        title: "Code edits",
        body: "First-attempt patch quality is the strongest in the lineup. Opus is the right pick when the agent has to modify code that must keep compiling and passing tests.",
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
        body: "Analysis over 100K+ tokens of transcripts, contracts, or specs. Opus's 200K window holds the whole picture without losing earlier sections.",
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
        body: "Same multiplier (×1.7) and same context window. Opus 4.7 is newer and stronger — pick 4.7 for new agents. Pin 4.6 only if a specific agent has been validated against that version and you need behaviour stability.",
      },
      {
        vs: "Kimi K2.6",
        body: "Kimi K2.6 (×0.3) wins on raw long-context recall in our internal evaluation and is reachable from China. Opus 4.7 still leads on tool-routing accuracy and code edits. Pair them: Opus as orchestrator, Kimi for long-context sub-agents in China-region runs.",
      },
    ],

    faqs: [
      {
        q: "How much does Claude Opus 4.7 cost on VM0?",
        a: "List price is $5 per 1M input tokens and $25 per 1M output tokens. On VM0 Managed it bills at ×1.7 of Claude Sonnet 4.6. Prompt caching cuts repeated input cost to $0.50 per 1M tokens.",
      },
      {
        q: "What is Claude Opus 4.7's context window?",
        a: "200K tokens, with up to 64K tokens of output per response.",
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
        a: "Pick Opus 4.7 when (a) the agent is the planner / orchestrator and decisions cascade, (b) the run is long enough that Sonnet starts dropping instructions, or (c) the output must apply cleanly on the first attempt (code edits, structured payloads).",
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

    metaTitle: "Claude Opus 4.6 on VM0: Specs, Pricing & When to Pin It",
    metaDescription:
      "Claude Opus 4.6 on VM0 — Anthropic's previous flagship. Pricing per 1M tokens, 200K context window, prompt caching, and when to pin Opus 4.6 instead of upgrading.",
    pageTitle: "Claude Opus 4.6 on VM0",
    tagline:
      "The previous Opus generation. Same multiplier and context as Opus 4.7 — keep it pinned only when an agent has been validated on this exact version.",

    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    chinaAccessible: false,
    releasedToVm0: "Available since launch",

    cardIntro:
      "The previous Opus generation. Same credit cost as Opus 4.7 — keep it pinned only if a specific agent has been validated against this version.",
    cardBestFor: [
      "Agents with frozen prompts that were tuned against Opus 4.6",
      "A/B comparing against Opus 4.7 on regression tests",
    ],
    cardAvoidFor: [
      "New agents — start with Opus 4.7 unless you have a reason to pin",
    ],

    summaryPoints: [
      "Anthropic's previous top-tier model.",
      "Same ×1.7 multiplier and 200K context as Opus 4.7, but with higher upstream list price.",
      "Pin 4.6 only when behaviour stability matters; otherwise upgrade to 4.7.",
    ],

    background: [
      "Claude Opus 4.6 was Anthropic's frontier model before Opus 4.7. It carried Anthropic's strongest reasoning and tool-use behaviour at the time of release and remains a capable choice for hard agent work.",
      "On VM0 it sits at the same ×1.7 credit multiplier as Opus 4.7. The vendor list price per token is higher, which is why most teams should default to 4.7 for new agents and reserve 4.6 for cases where a specific prompt has been carefully tuned against it.",
    ],

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "200K tokens" },
      { label: "Max output", value: "Up to 32K tokens" },
      { label: "Region", value: "Global; not directly reachable from China" },
      { label: "Available on VM0", value: "Available since launch" },
    ],

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
        body: "Strong on hard reasoning steps. Opus 4.7 is incrementally better on the same tasks at meaningfully lower vendor cost — there is no reasoning bench where 4.6 leads.",
      },
      {
        title: "Tool use",
        body: "Reliable across multi-tool agent flows. Same ballpark as Sonnet 4.6 on routing accuracy with extra robustness on edge cases.",
      },
      {
        title: "Speed",
        body: "Slower than Sonnet 4.6 and Haiku 4.5; comparable to Opus 4.7.",
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
        body: "Same ×1.7 multiplier and 200K context. Opus 4.7 is newer, faster, and cheaper at the vendor list-price layer. Pin 4.6 only when you've already invested in tuning against this version.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 is ×1 and handles most agent loops. Reach for Opus only when Sonnet visibly fails — usually for orchestration or hard code edits.",
      },
    ],

    faqs: [
      {
        q: "Should I migrate from Opus 4.6 to Opus 4.7?",
        a: "Yes for new work. Same multiplier, same context window, lower vendor list price, stronger behaviour on hard tasks. Migrate pinned agents only after running them through your regression suite.",
      },
      {
        q: "What is Claude Opus 4.6's context window?",
        a: "200K tokens with up to 32K tokens of output per response.",
      },
      {
        q: "Why is Opus 4.6 the default on the Anthropic API key provider?",
        a: "Historical default from before Opus 4.7 launched. You can switch any agent to Opus 4.7, Sonnet 4.6, or Haiku 4.5 in VM0 Settings → Model Providers without changing the API key.",
      },
    ],

    alternatives: [
      { slug: "claude-opus-4-7", reason: "Newer, cheaper at vendor cost" },
      { slug: "claude-sonnet-4-6", reason: "Sonnet baseline at much lower cost" },
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

    metaTitle: "Claude Sonnet 4.6: VM0's Default AI Agent Model",
    metaDescription:
      "Claude Sonnet 4.6 is the default model on VM0. ×1 credit baseline, 200K context, prompt caching, $3/M input. Pricing, specs, and the agent tasks it handles best.",
    pageTitle: "Claude Sonnet 4.6 on VM0 — the default agent model",
    tagline:
      "The default for most VM0 agents. Strong tool routing, good long-context behaviour, and the credit baseline — every other model is priced relative to Sonnet 4.6.",

    contextWindowK: 200,
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
      "VM0's default model — start here if you're not sure which one to pick.",
      "×1 credit baseline. $3/M input, $15/M output.",
      "Strongest tool-routing accuracy at this price point in our lineup.",
    ],

    background: [
      "Claude Sonnet 4.6 sits in the middle of Anthropic's Claude 4 family. It is the workhorse model designed to handle the full breadth of typical agent work — multi-tool routing, code edits, long-running conversations, and structured-output tasks — without the cost premium of Opus.",
      "Across VM0's Built-in lineup, every other model's credit multiplier is normalised against Sonnet 4.6 (×1). That means Sonnet is also the right pick when you want predictable budget conversations: “this agent runs at roughly 2× a Sonnet step” is a more useful sentence than absolute dollar quotes that move every quarter.",
      "Sonnet 4.6 supports Anthropic's prompt caching, which makes a big difference for VM0 agents that ship a stable system prompt and a fixed tool schema. Cached input tokens bill at $0.30 per 1M instead of $3 — a 10× saving on the parts of the prompt that don't change between turns.",
    ],

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "200K tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Region", value: "Global; not directly reachable from China" },
      { label: "Default for", value: "VM0 Managed" },
    ],

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
        body: "Faster than Opus and slower than Haiku. The right speed/quality balance for production agents.",
      },
      {
        title: "Cost predictability",
        body: "Sonnet's pricing has been stable, and prompt caching makes the on-VM0 cost especially predictable for agents with fixed system prompts.",
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
        body: "Haiku 4.5 is ×0.3 — three times cheaper than Sonnet. Sonnet wins on tool-routing accuracy and long-context coherence; Haiku wins on speed and cost. Use Haiku as a sub-agent or for high-volume simple flows.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro is ×0.3 with strong reasoning. It's the right call when cost dominates the decision and you can tolerate slightly weaker tool-routing on edge cases.",
      },
    ],

    faqs: [
      {
        q: "How much does Claude Sonnet 4.6 cost on VM0?",
        a: "List price is $3 per 1M input tokens and $15 per 1M output tokens. On VM0 Managed it bills at the ×1 credit baseline. Cached input drops to $0.30 per 1M tokens.",
      },
      {
        q: "Why is Sonnet 4.6 the default model on VM0 Managed?",
        a: "It hits the best balance of reasoning quality, tool-routing accuracy, and cost in our lineup. New agents almost always work on Sonnet without further tuning.",
      },
      {
        q: "What is Claude Sonnet 4.6's context window?",
        a: "200K tokens with up to 64K tokens of output per response.",
      },
      {
        q: "Does Sonnet 4.6 support image input?",
        a: "Yes. It's multimodal — text, code, and images.",
      },
      {
        q: "When should I switch off Sonnet 4.6?",
        a: "Switch to Opus 4.7 if Sonnet visibly drops the goal on long agent loops or fails on hard code edits. Switch to Haiku 4.5 or DeepSeek V4 Flash for high-volume simple flows where cost dominates.",
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

    metaTitle: "GLM-5.1 on VM0: 1M-Token Context Agents from Z.AI",
    metaDescription:
      "GLM-5.1 on VM0 — Z.AI's flagship with up to a 1M-token context window, China-region API, ×0.4 credit cost. Pricing, specs, and recommended agent tasks.",
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

    background: [
      "GLM-5.1 is the flagship of Zhipu AI's GLM series, distributed via Z.AI. It's a Chinese-built reasoning model with strong general capability and an unusually large context window — up to 1M tokens, which is several times larger than the Anthropic and Moonshot defaults.",
      "On VM0, GLM-5.1 is exposed two ways: through VM0 Managed (routed via OpenRouter with the upstream id `z-ai/glm-5.1`), and via a direct Z.AI API key (where it's the default model). Either path uses Z.AI's Anthropic-compatible interface, so existing VM0 agents drop in unchanged.",
      "GLM-5.1 became broadly available on VM0 in April 2026 when its feature flag was retired. It's the cost-efficient long-context option in the lineup, sitting at ×0.4 credits — less than half of Sonnet 4.6.",
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
        body: "GLM-5.1's 1M-token window is genuinely usable. It maintains coherence well past the 200K boundary that limits the Anthropic family — useful for whole-repo or whole-doc-corpus agents.",
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
        body: "Both are China-region long-context options at similar credit cost (×0.4 vs ×0.3). Kimi has stronger long-context recall in our internal evaluation; GLM-5.1 wins on raw context size (1M vs 200K). Pick Kimi for very long transcripts; pick GLM-5.1 when you need to stuff a whole codebase into one prompt.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 (×1) leads on tool-routing accuracy and English-language reasoning. GLM-5.1 (×0.4) leads on context window and is the right pick when cost or China-region access dominates the decision.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro (×0.3) is cheaper but with a smaller 128K context. Pick DeepSeek for cost-sensitive standard-context work; pick GLM-5.1 when context size is the constraint.",
      },
    ],

    faqs: [
      {
        q: "How big is GLM-5.1's context window on VM0?",
        a: "Up to 1 million tokens — the largest in our Built-in lineup. That's enough to fit a mid-sized repository or several hundred documents in a single prompt.",
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

    metaTitle: "Claude Haiku 4.5: Fast, Cheap AI Agent Triage on VM0",
    metaDescription:
      "Claude Haiku 4.5 on VM0 — Anthropic's fast, low-cost model. ×0.3 multiplier, $1/M input, prompt caching, ideal for Slack triage and routing agents.",
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
      "×0.3 credit multiplier; $1/M input, $5/M output.",
      "Best for triage, classification, and short-tool-call agents — not for long reasoning loops.",
    ],

    background: [
      "Claude Haiku 4.5 is the small, fast member of the Claude 4 family. It is built for latency-sensitive and high-volume work where Sonnet would be overkill — single-tool calls, fast classifications, short summarisations, and simple Slack replies.",
      "Haiku trades some reasoning depth and long-loop coherence for speed and cost. On VM0 it shines as the model behind sub-agents inside a larger Sonnet- or Opus-tier orchestrator: the orchestrator picks the strategy, Haiku does the cheap legwork.",
      "Despite being the small Claude, Haiku 4.5 is multimodal (vision-capable) and supports prompt caching, so even high-volume image-driven workflows stay cheap.",
    ],

    specs: [
      ...ANTHROPIC_SPECS_COMMON,
      { label: "Context window", value: "200K tokens" },
      { label: "Max output", value: "Up to 64K tokens" },
      { label: "Region", value: "Global; not directly reachable from China" },
      { label: "Best for", value: "High-volume / latency-sensitive flows" },
    ],

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
        body: "Fastest model in the Built-in lineup. Reply latency is short enough for interactive Slack agents.",
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
        body: "Sonnet (×1) is the default for full agents. Haiku (×0.3) is the right pick when speed and cost matter more than long-loop coherence — typically as a worker under a Sonnet/Opus planner.",
      },
      {
        vs: "DeepSeek V4 Flash",
        body: "DeepSeek V4 Flash (×0.02) is much cheaper but with weaker tool-use and less reliable on multi-step loops. Use Flash for one-shot bulk work; use Haiku for short interactive Slack-style replies.",
      },
    ],

    faqs: [
      {
        q: "How much does Claude Haiku 4.5 cost on VM0?",
        a: "List price is $1 per 1M input tokens and $5 per 1M output tokens. On VM0 Managed it bills at ×0.3 of Claude Sonnet 4.6. Cached input drops to $0.10 per 1M tokens.",
      },
      {
        q: "Is Haiku 4.5 multimodal?",
        a: "Yes. Haiku 4.5 accepts image inputs alongside text and code, so vision-driven agents work natively.",
      },
      {
        q: "When should I pick Haiku over Sonnet?",
        a: "Pick Haiku when (a) the agent loop is short — usually under 5 turns, (b) latency matters more than reasoning depth, or (c) you need a cheap sub-agent under a Sonnet/Opus orchestrator.",
      },
      {
        q: "Can Haiku run multi-tool agents?",
        a: "It can, but accuracy drops on edge cases compared to Sonnet 4.6. Keep the tool surface narrow and the loop short, or fall back to Sonnet.",
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

    metaTitle: "Kimi K2.6 on VM0: Long-Context China-Region AI Agents",
    metaDescription:
      "Kimi K2.6 on VM0 — Moonshot's flagship with strong long-context recall, China-accessible API, ×0.3 credit cost. Pricing, specs, and recommended agent tasks.",
    pageTitle: "Kimi K2.6 on VM0 — long-context China-region agents",
    tagline:
      "Moonshot's latest. Best-in-class long-context recall in our internal evaluation, China-region API, and a Claude-compatible interface.",

    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Code"],
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
      "Moonshot's latest Kimi — strongest long-context recall in our internal evaluation.",
      "×0.3 credit cost; reachable from mainland China without a proxy.",
      "Drop-in Claude-compatible API — existing VM0 agents work unchanged.",
    ],

    background: [
      "Kimi K2.6 is the latest generation of Moonshot AI's Kimi series. Moonshot has spent the last several years optimising for long-context Chinese-language reasoning, and K2.6 is the strongest result of that line of work to date.",
      "On VM0 it's exposed via the Moonshot API key as the default model and through VM0 Managed at the same ×0.3 multiplier. The API is Anthropic-compatible, so VM0 agents written for Claude work without code changes.",
      "K2.6 is the natural pick when your users are in China and you need a model that genuinely handles long agent transcripts — research workflows, support-ticket archaeology, document review jobs.",
    ],

    specs: [
      { label: "Family", value: "Kimi K2 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "200K tokens" },
      { label: "Prompt caching", value: "Supported (Anthropic-compatible)" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "April 2026" },
    ],

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
        title: "Reasoning",
        body: "Strong on Chinese-language tasks; competitive on English. Below Sonnet 4.6 on the hardest multi-tool English routing.",
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
        title: "Document-heavy workflows",
        body: "Contracts, regulatory filings, internal wiki research. The 200K context plus strong recall makes K2.6 a good doc-corpus reasoner at low cost.",
      },
    ],
    avoidFor: [
      "Hardest tool-routing edge cases — Sonnet 4.6 leads",
      "Latency-critical chat replies — Haiku 4.5 is faster",
    ],

    comparisons: [
      {
        vs: "GLM-5.1",
        body: "Both are China-region long-context options. K2.6 wins on raw long-context recall in our internal evaluation; GLM-5.1 wins on context size (1M vs 200K). Default to K2.6 for long transcripts; reach for GLM-5.1 only when you need >200K tokens in a single prompt.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet (×1) leads on multi-tool English-language routing. K2.6 (×0.3) wins on cost, on Chinese-language work, and on China-region access. Pair them: Sonnet for global users, K2.6 for China.",
      },
      {
        vs: "Kimi K2.5",
        body: "K2.6 is the newer generation with better tool-use and reasoning. K2.5 (×0.2) is slightly cheaper and useful for legacy pinned agents. Prefer K2.6 for new work.",
      },
    ],

    faqs: [
      {
        q: "How much does Kimi K2.6 cost on VM0?",
        a: "Moonshot's list price is $0.60 per 1M input tokens and $3 per 1M output tokens. On VM0 Managed it bills at ×0.3 of Claude Sonnet 4.6.",
      },
      {
        q: "Is Kimi K2.6 reachable from China?",
        a: "Yes. Moonshot's API is hosted in China and reachable without a proxy. VM0 routes the Moonshot provider directly.",
      },
      {
        q: "What's the context window?",
        a: "200K tokens — same as the Anthropic family. K2.6 differentiates on recall quality at that size, not raw window size.",
      },
      {
        q: "Do I need to rewrite my agent to use Kimi?",
        a: "No. Kimi K2.6 exposes an Anthropic-compatible API, so VM0 agents tuned for Claude work without code changes.",
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

    metaTitle: "DeepSeek V4 Pro on VM0: Cost-Optimized AI Agents",
    metaDescription:
      "DeepSeek V4 Pro on VM0 — strong reasoning at ×0.3 credit cost, China-accessible, prompt caching with free writes. Pricing, specs, and recommended agent tasks.",
    pageTitle: "DeepSeek V4 Pro on VM0 — cost-optimised reasoning",
    tagline:
      "DeepSeek's flagship. Strong reasoning at one-third of Sonnet's credit cost, China-accessible, Claude-compatible API.",

    contextWindowK: 128,
    promptCaching: true,
    modalities: ["Text", "Code"],
    chinaAccessible: true,
    releasedToVm0: "April 2026",

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
      "DeepSeek's strongest model — reasoning quality competitive with Sonnet at ×0.3 cost.",
      "Cache reads are billed; cache writes are free — a real cost win on stable system prompts.",
      "China-accessible, Claude-compatible API. Drop-in for VM0 agents.",
    ],

    background: [
      "DeepSeek V4 Pro is the flagship of DeepSeek's V4 generation, designed as the “reasoning” variant alongside the cheaper, faster V4 Flash. It's the right pick when you need a credible alternative to Claude Sonnet at a much lower per-token cost.",
      "DeepSeek made waves through 2025 by delivering Anthropic-grade reasoning at a fraction of the price. V4 Pro continues that pattern: Claude-compatible API, strong multi-step reasoning, and enough cost headroom to be the default for high-volume agent work.",
      "On VM0, V4 Pro is exposed via the DeepSeek API-key provider and on VM0 Managed at ×0.3 — the same multiplier as Claude Haiku 4.5 but with substantially stronger reasoning behaviour.",
    ],

    specs: [
      { label: "Family", value: "DeepSeek V4 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "128K tokens" },
      { label: "Prompt caching", value: "Read billed, writes free" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "April 2026" },
    ],

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
        body: "Strongest sub-Sonnet reasoning in our lineup. Holds up on multi-step work where cheaper models start to drift.",
      },
      {
        title: "Tool use",
        body: "Reliable across the common VM0 tool surface. Edge cases in deeply nested tool calls are handled less crisply than Sonnet 4.6.",
      },
      {
        title: "Cost efficiency",
        body: "The standout property. ×0.3 credit cost with reasoning that competes well with Sonnet 4.6 makes V4 Pro the cost-optimisation default.",
      },
      {
        title: "Cache economics",
        body: "Cache writes are free — unique among VM0's Built-in models. Stable system prompts and large pasted reference docs cost nothing extra to cache, only the read side bills.",
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
    ],
    avoidFor: [
      "Hardest tool-routing edge cases — Sonnet 4.6 leads",
      "Bulk single-shot work where reasoning isn't required — V4 Flash is 15× cheaper",
    ],

    comparisons: [
      {
        vs: "DeepSeek V4 Flash",
        body: "Same vendor, different positioning. V4 Pro (×0.3) gives you reasoning; V4 Flash (×0.02) gives you the cheapest possible single-shot model. Run V4 Flash as a pre-filter and escalate hard cases to V4 Pro.",
      },
      {
        vs: "Claude Sonnet 4.6",
        body: "Sonnet 4.6 (×1) wins on tool-routing edge cases and English-language reasoning. V4 Pro (×0.3) wins on cost and is competitive on most general reasoning. Worth A/B-testing on a real agent before committing.",
      },
      {
        vs: "Kimi K2.6",
        body: "Same multiplier (×0.3). Kimi has stronger long-context recall (200K vs 128K) and is China-region by design. V4 Pro has the better cache economics (free writes). Pick by which property you need more of.",
      },
    ],

    faqs: [
      {
        q: "How much does DeepSeek V4 Pro cost on VM0?",
        a: "DeepSeek's list price is $1.74 per 1M input tokens and $3.48 per 1M output tokens. On VM0 Managed it bills at ×0.3 of Claude Sonnet 4.6.",
      },
      {
        q: "Why are cache writes free?",
        a: "DeepSeek doesn't bill the cache-write portion. Only cache reads bill, at $0.145 per 1M tokens. Stable system prompts and large reference contexts cost nothing extra to cache.",
      },
      {
        q: "What's V4 Pro's context window?",
        a: "128K tokens. That's smaller than Claude (200K) and much smaller than GLM-5.1 (1M). For very long contexts, prefer Kimi K2.6 or GLM-5.1.",
      },
      {
        q: "Is V4 Pro reachable from China?",
        a: "Yes. DeepSeek's API is reachable from mainland China without a proxy.",
      },
    ],

    alternatives: [
      { slug: "deepseek-v4-flash", reason: "50× cheaper, single-shot work" },
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

    metaTitle: "Kimi K2.5 on VM0: Moonshot's Previous Long-Context Model",
    metaDescription:
      "Kimi K2.5 on VM0 — Moonshot's previous flagship, ×0.2 credit multiplier, 200K context, China-accessible. When to pin K2.5 instead of upgrading to K2.6.",
    pageTitle: "Kimi K2.5 on VM0 — Moonshot's previous generation",
    tagline:
      "The previous Kimi generation. Cheaper than K2.6 but with weaker tool-use; pin it only if a specific agent was validated on this version.",

    contextWindowK: 200,
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
      "Pin K2.5 only when behaviour stability matters; otherwise upgrade.",
    ],

    background: [
      "Kimi K2.5 was Moonshot's flagship Kimi model before K2.6. It was the first widely-deployed Kimi to combine long-context reasoning with a Claude-compatible API surface.",
      "On VM0 it sits at the same vendor list price as K2.6 but a lower credit multiplier (×0.2). The lower multiplier reflects positioning rather than raw token cost — K2.6 is the recommended default for new work.",
    ],

    specs: [
      { label: "Family", value: "Kimi K2 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "200K tokens" },
      { label: "Prompt caching", value: "Supported" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "Available since launch" },
    ],

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
    ],

    comparisons: [
      {
        vs: "Kimi K2.6",
        body: "K2.6 is the newer generation with stronger tool-use and reasoning. K2.5 (×0.2) is slightly cheaper. Pick K2.5 only for pinned legacy agents.",
      },
      {
        vs: "DeepSeek V4 Pro",
        body: "DeepSeek V4 Pro (×0.3) has stronger reasoning. K2.5 (×0.2) wins on context size and stays within the Moonshot API surface.",
      },
    ],

    faqs: [
      {
        q: "Why does K2.5 have a lower multiplier than K2.6 at the same vendor price?",
        a: "Multipliers reflect VM0's positioning of each model in the lineup, not just per-token cost. K2.6 is the recommended Kimi default at ×0.3; K2.5 is positioned as legacy at ×0.2.",
      },
      {
        q: "Should I migrate from K2.5 to K2.6?",
        a: "Yes for new work. Same vendor price, stronger tool-use and reasoning. Migrate pinned agents only after running them through your regression suite.",
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

    metaTitle: "MiniMax M2.7 on VM0: Multilingual AI Agents at ×0.1",
    metaDescription:
      "MiniMax M2.7 on VM0 — strong Chinese-language and multilingual reasoning at ×0.1 credit cost, 50-minute timeout, China-region endpoint. Pricing and recommended tasks.",
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

    background: [
      "MiniMax M2.7 is from MiniMax — a Chinese AI lab known for multilingual capability and a multimodal product line. The text reasoning side is what's exposed on VM0.",
      "On VM0, M2.7 is the default model on the MiniMax API-key provider. The Built-in lineup carries it at ×0.1 — one of the lowest multipliers in the catalogue — making it the default cheap-but-credible reasoner for Chinese-language workloads.",
      "VM0's MiniMax provider sets a 50-minute API timeout and disables non-essential traffic, so long thinking steps complete reliably.",
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
    ],

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

    metaTitle: "DeepSeek V4 Flash on VM0: Cheapest AI Model (×0.02)",
    metaDescription:
      "DeepSeek V4 Flash on VM0 — the cheapest Built-in model at ×0.02 credit cost. Pricing, 128K context, free cache writes, and the bulk tasks it handles best.",
    pageTitle: "DeepSeek V4 Flash on VM0 — the cheapest model",
    tagline:
      "The cheapest model in the lineup — 50× less than Sonnet 4.6. Good for high-volume single-shot tasks where the prompt does most of the work.",

    contextWindowK: 128,
    promptCaching: true,
    modalities: ["Text", "Code"],
    chinaAccessible: true,
    releasedToVm0: "April 2026",

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
      "Cache reads bill, writes are free. Stable prompts cost almost nothing.",
      "Best as a pre-filter or one-shot worker; not a long-loop agent.",
    ],

    background: [
      "DeepSeek V4 Flash is the cost-leader in DeepSeek's V4 generation. Where V4 Pro is positioned for reasoning, Flash is positioned for the absolute lowest unit cost — a model you can run at very high volumes without thinking about budget.",
      "On VM0 it carries a ×0.02 credit multiplier — the lowest in the entire Built-in catalogue. That makes it the default for bulk classification, tagging, extraction, and pre-filter workloads where the prompt does most of the work and the model just needs to follow instructions reliably.",
      "It shares the V4 family's free cache-write economics: only cache reads bill. With a stable system prompt across a million calls, the cost stays close to the per-output-token line item.",
    ],

    specs: [
      { label: "Family", value: "DeepSeek V4 series" },
      { label: "Modalities", value: "Text, code" },
      { label: "Languages", value: "Chinese-strong, multilingual" },
      { label: "Context window", value: "128K tokens" },
      { label: "Prompt caching", value: "Read billed, writes free" },
      { label: "Region", value: "China-accessible" },
      { label: "Available on VM0", value: "April 2026" },
    ],

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
        title: "Context window",
        body: "128K tokens — same as V4 Pro. Smaller than Claude (200K) and much smaller than GLM-5.1 (1M).",
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
    ],
    avoidFor: [
      "Multi-step agent loops — V4 Flash drifts on long tool chains",
      "Hard reasoning, code edits, or planner roles — V4 Pro or Sonnet 4.6 instead",
    ],

    comparisons: [
      {
        vs: "DeepSeek V4 Pro",
        body: "Same vendor; V4 Pro (×0.3) does the reasoning, V4 Flash (×0.02) does the volume. The classic split: Flash as the pre-filter, Pro as the escalator. 15× cost difference.",
      },
      {
        vs: "Claude Haiku 4.5",
        body: "Haiku 4.5 (×0.3) is more reliable on multi-tool routing and faster on interactive flows. V4 Flash (×0.02) wins on raw cost. Pick Flash for batch jobs; pick Haiku for interactive Slack-style replies.",
      },
      {
        vs: "MiniMax M2.7",
        body: "M2.7 (×0.1) is stronger on Chinese-language reasoning and has a 50-minute timeout for long thinking. V4 Flash (×0.02) is faster and far cheaper for single-shot work.",
      },
    ],

    faqs: [
      {
        q: "How much does DeepSeek V4 Flash cost on VM0?",
        a: "DeepSeek's list price is $0.14 per 1M input tokens and $0.28 per 1M output tokens. On VM0 Managed it bills at ×0.02 of Claude Sonnet 4.6 — the cheapest model in our catalogue.",
      },
      {
        q: "Should I run my entire agent on V4 Flash?",
        a: "Probably not. Flash is great at one-shot tasks but drifts on long multi-step loops. The standard pattern is to use it as a pre-filter and escalate the hard cases to V4 Pro or Sonnet 4.6.",
      },
      {
        q: "Are cache writes really free?",
        a: "Yes — DeepSeek doesn't bill the cache-write portion. Only cache reads bill, at $0.028 per 1M tokens.",
      },
      {
        q: "Is V4 Flash reachable from China?",
        a: "Yes. DeepSeek's API is reachable from mainland China without a proxy.",
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
