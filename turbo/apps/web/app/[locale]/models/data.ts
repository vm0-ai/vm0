// ---------------------------------------------------------------------------
// Models — the Built-in lineup shown on /models.
//
// The model order and credit multipliers mirror the platform's model picker
// (turbo/apps/platform/src/views/zero-page/components/settings/provider-ui-config.ts).
// Each entry has a short intro and recommendations for using it on VM0.
// ---------------------------------------------------------------------------

export interface ModelEntry {
  /** Slug for /models/[slug] route. */
  slug: string;
  /** Display name as shown in the platform model picker. */
  name: string;
  /** Vendor / family. */
  vendor: string;
  /** Credit multiplier — Sonnet 4.6 = ×1. */
  multiplier: number;
  /** One-paragraph introduction (≤ ~280 chars). */
  intro: string;
  /** 2–4 short recommendations: when to pick this model on VM0. */
  bestFor: string[];
  /** 1–2 short caveats: when not to use it. */
  avoidFor: string[];
}

export const MODELS: ModelEntry[] = [
  {
    slug: "claude-opus-4-7",
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
  },
  {
    slug: "claude-opus-4-6",
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
  },
  {
    slug: "claude-sonnet-4-6",
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
  },
  {
    slug: "glm-5.1",
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
  },
  {
    slug: "claude-haiku-4-5",
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
  },
  {
    slug: "kimi-k2.6",
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
  },
  {
    slug: "deepseek-v4-pro",
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
  },
  {
    slug: "kimi-k2.5",
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
  },
  {
    slug: "minimax-m2.7",
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
  },
  {
    slug: "deepseek-v4-flash",
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
  },
];

export function getModelBySlug(slug: string): ModelEntry | undefined {
  return MODELS.find((m) => {
    return m.slug === slug;
  });
}
