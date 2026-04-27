// ---------------------------------------------------------------------------
// Models — the Built-in lineup shown on /models and /models/[slug].
//
// Order, multipliers, and pricing mirror the platform's model picker:
//   - turbo/packages/api-contracts/src/contracts/model-providers.ts
//     (VM0_MODEL_TO_PROVIDER, MODEL_PROVIDER_TYPES — defaults & timeouts)
//   - turbo/apps/platform/.../settings/provider-ui-config.ts
//     (VM0_MODEL_CREDIT_MULTIPLIER)
//   - turbo/apps/web/scripts/dev-seed.ts (MODEL_PRICING — USD per 1M tokens)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputUsd: number;
  /** USD per 1M output tokens. */
  outputUsd: number;
  /** USD per 1M cached input tokens. */
  cacheReadUsd: number;
  /**
   * USD per 1M tokens to write to the prompt cache.
   * `null` when the upstream provider does not bill cache writes
   * (e.g. DeepSeek).
   */
  cacheWriteUsd: number | null;
}

export interface ModelEntry {
  /** Slug for /models/[slug]. */
  slug: string;
  /** Internal model id used at the API layer. */
  modelId: string;
  /** Display name as shown in the platform model picker. */
  name: string;
  /** Vendor label. */
  vendor: string;
  /** Credit multiplier — Sonnet 4.6 = ×1. */
  multiplier: number;
  /** One-paragraph intro shown on the list page. */
  intro: string;
  /** What this model is good for on VM0. */
  bestFor: string[];
  /** When to skip this model. */
  avoidFor: string[];

  // Detail-page fields ------------------------------------------------------

  pricing: ModelPricing;
  /** Context window in K tokens, when documented. */
  contextWindowK?: number;
  /** Whether the model supports Anthropic-compatible prompt caching. */
  promptCaching: boolean;
  /** VM0-set API timeout in minutes (only set for some BYOK providers). */
  vm0TimeoutMin?: number;
  /** Provider configurations that default to this model. */
  defaultFor: string[];
  /** How VM0 routes this model. */
  routingNotes: string;
  /** Bullet notes about how this model behaves on VM0. */
  vm0Notes: string[];
  /** Approximate window when this model became available on VM0. */
  releasedToVm0: string;
  /** Suggested alternatives — links to other slugs. */
  alternatives: { slug: string; reason: string }[];
  /** ≤ 60-char detail-page H1. */
  detailHeading: string;
  /** ≤ 160-char meta description. */
  metaDescription: string;
}

export const MODELS: ModelEntry[] = [
  {
    slug: "claude-opus-4-7",
    modelId: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    vendor: "Anthropic",
    multiplier: 1.7,
    intro:
      "Anthropic's strongest model. Highest reasoning quality on multi-step agent loops, long-context recall, and code edits — at the highest credit cost in the lineup.",
    bestFor: [
      "Complex agent tasks that require reasoning across many tools",
      "Long-running runs with 100k+ tokens of accumulated context",
      "Code edits where the patch needs to apply cleanly on the first try",
    ],
    avoidFor: [
      "High-volume routine tasks where Sonnet 4.6 or Haiku 4.5 is enough",
    ],
    pricing: {
      inputUsd: 5,
      outputUsd: 25,
      cacheReadUsd: 0.5,
      cacheWriteUsd: 6.25,
    },
    contextWindowK: 200,
    promptCaching: true,
    defaultFor: [],
    routingNotes:
      "Routed directly to Anthropic's Messages API. Available on the VM0 Managed pool and via the Anthropic / Claude Code OAuth provider connections.",
    vm0Notes: [
      "Most expensive Built-in model — Sonnet 4.6 is the default for a reason; promote to Opus 4.7 for the hardest steps.",
      "Prompt caching is supported and substantially cuts cost on repeated system prompts and tool definitions.",
      "Uses the Anthropic API directly with no extra timeout overrides.",
    ],
    releasedToVm0: "April 2026",
    alternatives: [
      {
        slug: "claude-sonnet-4-6",
        reason: "Cheaper default for most agent loops",
      },
      {
        slug: "kimi-k2.6",
        reason: "Stronger long-context recall at lower cost",
      },
    ],
    detailHeading: "Claude Opus 4.7 on VM0",
    metaDescription:
      "Run Claude Opus 4.7 on VM0 — Anthropic's strongest reasoning model. Pricing, context window, prompt caching support, and recommended task types.",
  },
  {
    slug: "claude-opus-4-6",
    modelId: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    vendor: "Anthropic",
    multiplier: 1.7,
    intro:
      "The previous Opus generation. Same credit cost as Opus 4.7 — keep it pinned only if a specific agent has been validated against this version.",
    bestFor: [
      "Agents with frozen prompts that were tuned against Opus 4.6",
      "A/B comparing against Opus 4.7 on regression tests",
    ],
    avoidFor: [
      "New agents — start with Opus 4.7 unless you have a reason to pin",
    ],
    pricing: {
      inputUsd: 15,
      outputUsd: 75,
      cacheReadUsd: 1.5,
      cacheWriteUsd: 18.75,
    },
    contextWindowK: 200,
    promptCaching: true,
    defaultFor: ["Anthropic API key", "Claude Code OAuth"],
    routingNotes:
      "Routed directly to Anthropic's Messages API. Available on VM0 Managed and as the default model on the Anthropic and Claude Code OAuth provider connections.",
    vm0Notes: [
      "Highest list-price tokens of any Built-in model — Opus 4.7 is now the recommended Opus tier on VM0.",
      "Prompt caching is supported; lean on it heavily to keep cost reasonable.",
    ],
    releasedToVm0: "Earlier",
    alternatives: [
      {
        slug: "claude-opus-4-7",
        reason: "Newer, same multiplier, same context window",
      },
      {
        slug: "claude-sonnet-4-6",
        reason: "Sonnet baseline at much lower cost",
      },
    ],
    detailHeading: "Claude Opus 4.6 on VM0",
    metaDescription:
      "Run Claude Opus 4.6 on VM0. Pricing, context window, prompt caching, and when to pin this generation instead of upgrading to Opus 4.7.",
  },
  {
    slug: "claude-sonnet-4-6",
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    vendor: "Anthropic",
    multiplier: 1,
    intro:
      "The default for most VM0 agents. Strong tool-routing accuracy, good long-context behaviour, and the credit baseline — every other model is priced relative to Sonnet 4.6.",
    bestFor: [
      "The default choice when you're not sure which model to pick",
      "Multi-tool agents that need reliable routing across Slack, GitHub, Linear, Notion",
      "Workflows where you want a stable cost baseline",
    ],
    avoidFor: [
      "Tasks that demand maximum reasoning depth — escalate to Opus 4.7",
      "Very high-volume cheap tasks — drop to Haiku 4.5 or DeepSeek V4 Flash",
    ],
    pricing: {
      inputUsd: 3,
      outputUsd: 15,
      cacheReadUsd: 0.3,
      cacheWriteUsd: 3.75,
    },
    contextWindowK: 200,
    promptCaching: true,
    defaultFor: ["VM0 Managed"],
    routingNotes:
      "Routed directly to Anthropic's Messages API. Default model on VM0 Managed.",
    vm0Notes: [
      "Sonnet 4.6 is the credit baseline (×1) — every other Built-in model's multiplier is normalised against this one.",
      "First choice for new agents on VM0; only escalate to Opus when Sonnet underperforms a specific task.",
      "Native prompt caching pairs well with VM0's stable system prompts and tool definitions.",
    ],
    releasedToVm0: "Earlier",
    alternatives: [
      {
        slug: "claude-opus-4-7",
        reason: "Use when Sonnet hits its reasoning ceiling",
      },
      {
        slug: "claude-haiku-4-5",
        reason: "Cheaper sibling for routing and triage",
      },
      { slug: "deepseek-v4-pro", reason: "Far cheaper alternative on cost" },
    ],
    detailHeading: "Claude Sonnet 4.6 on VM0 — the default agent model",
    metaDescription:
      "Claude Sonnet 4.6 is the default model on VM0. Pricing, context window, prompt caching, and the tasks it handles best as your agent baseline.",
  },
  {
    slug: "glm-5.1",
    modelId: "glm-5.1",
    name: "GLM-5.1",
    vendor: "Z.AI",
    multiplier: 0.4,
    intro:
      "Z.AI's flagship. Up to a 1M-token context window and a China-region endpoint — strong for whole-codebase or whole-knowledge-base agents at well below Sonnet pricing.",
    bestFor: [
      "Agents that consume an entire repository or document corpus in one run",
      "China-region deployments where Anthropic isn't reachable",
      "Cost-sensitive long-context jobs",
    ],
    avoidFor: ["Highest-stakes reasoning — Sonnet 4.6 or Opus 4.7 is safer"],
    pricing: {
      inputUsd: 1.4,
      outputUsd: 4.4,
      cacheReadUsd: 0.26,
      cacheWriteUsd: 1.4,
    },
    contextWindowK: 1000,
    promptCaching: true,
    vm0TimeoutMin: 50,
    defaultFor: ["Z.AI"],
    routingNotes:
      "On VM0 Managed, GLM-5.1 is routed through OpenRouter with the upstream id `z-ai/glm-5.1`. With a Z.AI API key it talks to `api.z.ai`'s Anthropic-compatible endpoint directly.",
    vm0Notes: [
      "VM0 sets a 50-minute API timeout for the Z.AI provider — deep reasoning steps complete reliably.",
      "1M-token context is the largest in the Built-in lineup; pair with high-volume document agents.",
      "Reachable from mainland China without a proxy.",
    ],
    releasedToVm0: "April 2026",
    alternatives: [
      { slug: "kimi-k2.6", reason: "Other strong China-region long-context option" },
      { slug: "deepseek-v4-pro", reason: "Cheaper Chinese model with shorter context" },
    ],
    detailHeading: "GLM-5.1 on VM0 — long-context, China-friendly agents",
    metaDescription:
      "Run GLM-5.1 on VM0 — up to 1M-token context, China-region endpoint, 0.4× the credit cost of Claude Sonnet 4.6. Pricing and recommended tasks.",
  },
  {
    slug: "claude-haiku-4-5",
    modelId: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    vendor: "Anthropic",
    multiplier: 0.3,
    intro:
      "The fast, cheap Claude. Good enough for routing, short summarisation, and simple tool calls at a fraction of Sonnet's cost.",
    bestFor: [
      "Slack triage, classification, and routing agents",
      "Per-message replies in chat threads where latency matters",
      "Sub-agents inside a larger Sonnet/Opus orchestrator",
    ],
    avoidFor: [
      "Multi-step reasoning — Haiku will lose track on long agent loops",
    ],
    pricing: {
      inputUsd: 1,
      outputUsd: 5,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 1.25,
    },
    contextWindowK: 200,
    promptCaching: true,
    defaultFor: [],
    routingNotes:
      "Routed directly to Anthropic's Messages API. Available on VM0 Managed and the Anthropic / Claude Code OAuth providers.",
    vm0Notes: [
      "Best Haiku-tier multiplier (×0.3) makes it the right pick for high-volume routing workloads.",
      "Prompt caching keeps cost down on repeated short prompts.",
      "Doesn't carry the multi-step agent quality of Sonnet — keep loops short.",
    ],
    releasedToVm0: "Earlier",
    alternatives: [
      { slug: "claude-sonnet-4-6", reason: "Step up when routing fidelity matters" },
      { slug: "deepseek-v4-flash", reason: "Even cheaper for single-shot tasks" },
    ],
    detailHeading: "Claude Haiku 4.5 on VM0 — fast, cheap routing",
    metaDescription:
      "Claude Haiku 4.5 on VM0 — 0.3× multiplier, prompt caching, ideal for Slack triage and classification agents. Pricing and recommended tasks.",
  },
  {
    slug: "kimi-k2.6",
    modelId: "kimi-k2.6",
    name: "Kimi K2.6",
    vendor: "Moonshot",
    multiplier: 0.3,
    intro:
      "Moonshot's latest. Best-in-class long-context recall in our internal evaluation, China-region API, and a Claude-compatible interface.",
    bestFor: [
      "Long agent transcripts that exceed 200k tokens",
      "China-region agents that need a strong reasoner",
      "Research-style tasks with large supporting documents",
    ],
    avoidFor: [
      "Multi-tool routing accuracy edge cases — Sonnet 4.6 still leads",
    ],
    pricing: {
      inputUsd: 0.6,
      outputUsd: 3,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0.6,
    },
    contextWindowK: 200,
    promptCaching: true,
    defaultFor: ["Moonshot"],
    routingNotes:
      "Routed through Moonshot's Anthropic-compatible endpoint at `api.moonshot.ai`. Default model on the Moonshot provider; also available on VM0 Managed and OpenRouter.",
    vm0Notes: [
      "Strongest long-context recall we've seen in the Built-in lineup.",
      "Cheap enough (×0.3) to be a viable Sonnet substitute for cost-sensitive Chinese-region work.",
      "Reachable from mainland China without a proxy.",
    ],
    releasedToVm0: "April 2026",
    alternatives: [
      { slug: "kimi-k2.5", reason: "Older generation, slightly cheaper multiplier" },
      { slug: "glm-5.1", reason: "Even longer context window (1M tokens)" },
    ],
    detailHeading: "Kimi K2.6 on VM0 — long-context China-region agents",
    metaDescription:
      "Kimi K2.6 on VM0 — Moonshot's flagship, strong long-context recall, China-accessible, 0.3× credit multiplier. Pricing and recommended tasks.",
  },
  {
    slug: "deepseek-v4-pro",
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    vendor: "DeepSeek",
    multiplier: 0.3,
    intro:
      "DeepSeek's flagship. Strong reasoning at one-third of Sonnet's credit cost, China-accessible, Claude-compatible API.",
    bestFor: [
      "Cost-sensitive agents that still need solid multi-step reasoning",
      "High-volume background workers (summarisation, extraction, batch review)",
      "China-region deployments with a tight unit-cost budget",
    ],
    avoidFor: [
      "Hardest tool-routing edge cases — Claude Sonnet 4.6 is more reliable",
    ],
    pricing: {
      inputUsd: 1.74,
      outputUsd: 3.48,
      cacheReadUsd: 0.145,
      cacheWriteUsd: null,
    },
    contextWindowK: 128,
    promptCaching: true,
    vm0TimeoutMin: 10,
    defaultFor: [],
    routingNotes:
      "Routed through DeepSeek's Anthropic-compatible endpoint at `api.deepseek.com`. Available on VM0 Managed and the DeepSeek provider.",
    vm0Notes: [
      "Cache reads are billed; cache writes are not — a cost win when system prompts are stable.",
      "VM0 sets a 10-minute API timeout and disables non-essential traffic for the DeepSeek provider.",
      "Strongest reasoning of any sub-Sonnet model in our lineup.",
    ],
    releasedToVm0: "April 2026",
    alternatives: [
      { slug: "deepseek-v4-flash", reason: "50× cheaper, single-shot work" },
      { slug: "claude-sonnet-4-6", reason: "Step up for hard tool routing" },
    ],
    detailHeading: "DeepSeek V4 Pro on VM0 — cost-optimised reasoning",
    metaDescription:
      "DeepSeek V4 Pro on VM0 — strong reasoning at 0.3× credit cost, China-accessible, prompt caching with free writes. Pricing and recommended tasks.",
  },
  {
    slug: "kimi-k2.5",
    modelId: "kimi-k2.5",
    name: "Kimi K2.5",
    vendor: "Moonshot",
    multiplier: 0.2,
    intro:
      "The previous Kimi generation. Cheaper than K2.6 but with weaker tool-use; pin it only if a specific agent was validated on this version.",
    bestFor: [
      "Long-context summarisation jobs where K2.6's edge isn't worth the credits",
      "Pinned legacy agents already tuned on K2.5",
    ],
    avoidFor: ["New agents — start with K2.6 unless you have a reason to pin"],
    pricing: {
      inputUsd: 0.6,
      outputUsd: 3,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0.6,
    },
    contextWindowK: 200,
    promptCaching: true,
    defaultFor: [],
    routingNotes:
      "Routed through Moonshot's Anthropic-compatible endpoint at `api.moonshot.ai`. Available on VM0 Managed, Moonshot, OpenRouter, and Vercel AI Gateway.",
    vm0Notes: [
      "Same per-token price as K2.6 but a lower multiplier (×0.2 vs ×0.3) — the multiplier reflects positioning, not raw cost.",
      "Solid long-context behaviour but K2.6 is the recommended choice for new work.",
    ],
    releasedToVm0: "Earlier",
    alternatives: [
      { slug: "kimi-k2.6", reason: "Newer Kimi with better tool-use" },
      { slug: "glm-5.1", reason: "Larger context window if you need it" },
    ],
    detailHeading: "Kimi K2.5 on VM0 — Moonshot's previous generation",
    metaDescription:
      "Kimi K2.5 on VM0 — Moonshot's previous flagship, 0.2× credit multiplier, China-accessible. When to pin K2.5 instead of upgrading to K2.6.",
  },
  {
    slug: "minimax-m2.7",
    modelId: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    vendor: "MiniMax",
    multiplier: 0.1,
    intro:
      "Strong Chinese-language and multilingual reasoning at one-tenth of Sonnet's credit cost. China-region API, generous timeout for long thinking steps.",
    bestFor: [
      "Chinese-language agents (writing, summarisation, customer-facing)",
      "Multilingual workflows where English isn't the primary language",
      "Cheap, latency-tolerant background workers",
    ],
    avoidFor: ["English-first multi-tool agents — Sonnet 4.6 is more reliable"],
    pricing: {
      inputUsd: 0.3,
      outputUsd: 1.2,
      cacheReadUsd: 0.06,
      cacheWriteUsd: 0.375,
    },
    contextWindowK: 200,
    promptCaching: true,
    vm0TimeoutMin: 50,
    defaultFor: ["MiniMax"],
    routingNotes:
      "Routed through MiniMax's Anthropic-compatible endpoint at `api.minimax.io`. Default model on the MiniMax provider; also available on VM0 Managed.",
    vm0Notes: [
      "VM0 sets a 50-minute API timeout and disables non-essential traffic for the MiniMax provider — long thinking steps survive without dropping.",
      "Lowest non-Flash multiplier — pair with high-volume Chinese-language workloads.",
    ],
    releasedToVm0: "Earlier",
    alternatives: [
      { slug: "kimi-k2.6", reason: "Stronger reasoning at a similar price" },
      { slug: "deepseek-v4-flash", reason: "Even cheaper if quality permits" },
    ],
    detailHeading: "MiniMax M2.7 on VM0 — multilingual at ×0.1",
    metaDescription:
      "MiniMax M2.7 on VM0 — strong Chinese-language reasoning at 0.1× credit cost, 50-minute timeout, China-region endpoint. Pricing and recommended tasks.",
  },
  {
    slug: "deepseek-v4-flash",
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    vendor: "DeepSeek",
    multiplier: 0.02,
    intro:
      "The cheapest model in the lineup — 50× less than Sonnet 4.6. Good for high-volume single-shot tasks where the prompt does most of the work.",
    bestFor: [
      "Bulk classification, tagging, and extraction jobs",
      "Pre-filters before handing the hard cases to a larger model",
      "Anywhere unit cost dominates the decision",
    ],
    avoidFor: [
      "Multi-step agent loops — V4 Flash will drift on long tool chains",
    ],
    pricing: {
      inputUsd: 0.14,
      outputUsd: 0.28,
      cacheReadUsd: 0.028,
      cacheWriteUsd: null,
    },
    contextWindowK: 128,
    promptCaching: true,
    vm0TimeoutMin: 10,
    defaultFor: ["DeepSeek"],
    routingNotes:
      "Routed through DeepSeek's Anthropic-compatible endpoint at `api.deepseek.com`. Default model on the DeepSeek provider; also available on VM0 Managed.",
    vm0Notes: [
      "Lowest credit multiplier of any Built-in model (×0.02) — 50× less than Sonnet 4.6.",
      "Cache reads are billed; cache writes are not.",
      "VM0 sets a 10-minute API timeout for the DeepSeek provider.",
    ],
    releasedToVm0: "April 2026",
    alternatives: [
      { slug: "deepseek-v4-pro", reason: "Same vendor, much stronger reasoning" },
      { slug: "claude-haiku-4-5", reason: "Anthropic alternative for routing" },
    ],
    detailHeading: "DeepSeek V4 Flash on VM0 — the cheapest model",
    metaDescription:
      "DeepSeek V4 Flash on VM0 — the cheapest Built-in model at 0.02× credit cost. Pricing, context window, and the bulk tasks it handles best.",
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
