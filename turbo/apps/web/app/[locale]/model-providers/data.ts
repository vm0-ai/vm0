// ---------------------------------------------------------------------------
// Model Providers — types, content, and helpers
//
// Source of truth: MODEL_PROVIDER_TYPES in @vm0/api-contracts. We DO NOT
// re-list providers here — adding a provider to the contract automatically
// surfaces it on the marketing pages. This file holds:
//
//   1. Display-only metadata (logo, accent colour) keyed off the contract.
//   2. Hand-curated SEO/marketing copy (intro, evaluation, FAQ).
//   3. A type-level guarantee that every selectable provider has copy.
// ---------------------------------------------------------------------------

import {
  MODEL_PROVIDER_TYPES,
  getSelectableProviderTypes,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";

// Selectable providers shown on /model-providers (excludes hidden enterprise
// integrations like aws-bedrock and azure-foundry).
export const PROVIDER_SLUGS = getSelectableProviderTypes();

export type ProviderSlug = ModelProviderType;

// ---------------------------------------------------------------------------
// Provider visual identity
// ---------------------------------------------------------------------------

export interface ProviderVisual {
  /** Logo path under /public. Falls back to a generated initials tile. */
  logo?: string;
  /** Background colour for the hero card on the detail page. */
  accent: string;
  /** Whether the logo SVG needs inversion in dark mode. */
  darkInvertLogo?: boolean;
}

const VISUALS: Record<ProviderSlug, ProviderVisual> = {
  vm0: { accent: "#ed4e01", logo: "/icon.svg" },
  "anthropic-api-key": {
    accent: "#d97757",
    logo: "/assets/connectors/anthropic.svg",
    darkInvertLogo: true,
  },
  "claude-code-oauth-token": {
    accent: "#d97757",
    logo: "/assets/connectors/anthropic.svg",
    darkInvertLogo: true,
  },
  "openrouter-api-key": { accent: "#6366f1" },
  "moonshot-api-key": { accent: "#1f6feb" },
  "minimax-api-key": { accent: "#7c3aed" },
  "deepseek-api-key": { accent: "#0ea5e9" },
  "zai-api-key": { accent: "#14b8a6" },
  "vercel-ai-gateway": { accent: "#000000" },
  // Hidden providers — included for type completeness, never rendered.
  "aws-bedrock": { accent: "#ff9900" },
  "azure-foundry": { accent: "#0078d4" },
};

// ---------------------------------------------------------------------------
// Editorial content (copy that drives SEO)
//
// Rule: each selectable provider MUST have an entry. The exhaustive type
// assertion at the bottom of this file makes this a compile-time error if
// someone adds a provider to the contract without writing copy.
// ---------------------------------------------------------------------------

export type EvaluationRating = "excellent" | "good" | "fair";

export interface ProviderEvaluation {
  scenario:
    | "tool-routing"
    | "long-context"
    | "code-edit"
    | "agent-loop"
    | "cost-efficiency";
  rating: EvaluationRating;
  notes: string;
}

export interface ProviderFaq {
  question: string;
  answer: string;
}

export interface ProviderContent {
  /** Short, marketable display name (overrides the contract `label`). */
  displayName: string;
  /** One-sentence positioning, used as the card subhead and meta description. */
  tagline: string;
  /** Region/audience tag shown on the comparison matrix. */
  bestFor:
    | "default"
    | "max-quality"
    | "cost-optimised"
    | "china-region"
    | "long-context"
    | "personal-pro"
    | "gateway"
    | "specialised";
  /** Headline benefits for SEO body copy. */
  strengths: string[];
  /** Honest tradeoffs — builds editorial credibility. */
  tradeoffs: string[];
  /** Who should pick this provider over the alternatives. */
  whenToChoose: string;
  /** vm0 evaluation, 3–5 scenarios. */
  evaluation: ProviderEvaluation[];
  /** FAQ entries, rendered with FAQPage JSON-LD. */
  faqs: ProviderFaq[];
  /** Two-three line intro paragraph for the detail-page hero. */
  intro: string;
  /** ≤ 60-char H1 for the detail page. */
  detailHeading: string;
  /** ≤ 155-char meta description for the detail page. */
  metaDescription: string;
  /** Region the provider is reachable from. */
  chinaAccessible: boolean;
  /** Relative cost band shown on the matrix. */
  costBand: "free-with-plan" | "$" | "$$" | "$$$" | "$$$$";
  /** Authentication method shown in the matrix. */
  authLabel: string;
}

// ---------------------------------------------------------------------------
// Content table
// ---------------------------------------------------------------------------

const CONTENT: Record<ProviderSlug, ProviderContent> = {
  vm0: {
    displayName: "VM0 Managed",
    tagline:
      "Run agents on Claude Opus, Sonnet, Haiku, GLM, Kimi, MiniMax, or DeepSeek — no API key required, billed through your VM0 plan.",
    bestFor: "default",
    chinaAccessible: true,
    costBand: "free-with-plan",
    authLabel: "Included with plan",
    strengths: [
      "Zero setup — no API key, no provider account, no billing relationship to manage",
      "Multi-vendor pool covering Claude, GLM, Kimi, MiniMax, and DeepSeek behind one entitlement",
      "Pooled keys are protected by the same VM0 firewall — sandboxes never see real credentials",
    ],
    tradeoffs: [
      "Fewer model versions exposed than direct provider access",
      "Per-run cost is fixed at the platform level — bring your own key if you need volume discounts",
    ],
    whenToChoose:
      "Pick VM0 Managed when you want to start running agents in under a minute and never think about LLM billing. Switch to a direct provider once you have a strong opinion about a specific model or want vendor-direct invoicing.",
    evaluation: [
      {
        scenario: "tool-routing",
        rating: "excellent",
        notes:
          "Default routes to Claude Sonnet 4.6, which leads on multi-tool agent benchmarks across our fleet.",
      },
      {
        scenario: "long-context",
        rating: "excellent",
        notes:
          "Opus 4.7 and Kimi K2.6 are both available — the latter wins on >500k token recall.",
      },
      {
        scenario: "code-edit",
        rating: "excellent",
        notes:
          "Opus 4.7 produces the cleanest patches in our internal benchmark; Sonnet 4.6 is the default for cost.",
      },
      {
        scenario: "cost-efficiency",
        rating: "good",
        notes:
          "DeepSeek and GLM models bring the per-run cost down by roughly 5–10× when quality allows.",
      },
    ],
    faqs: [
      {
        question: "Do I need an API key to use VM0 Managed?",
        answer:
          "No. VM0 Managed pools provider keys at the platform level. You select a model and the run is billed through your VM0 plan.",
      },
      {
        question: "Can I switch from VM0 Managed to my own API key later?",
        answer:
          "Yes. You can connect Anthropic, DeepSeek, Moonshot, Z.AI, MiniMax, OpenRouter, or Vercel AI Gateway at any time and route specific agents through your own credentials.",
      },
      {
        question: "Are Chinese models (Kimi, GLM, MiniMax, DeepSeek) included?",
        answer:
          "Yes — VM0 Managed currently exposes Claude Opus 4.7 / 4.6, Claude Sonnet 4.6, Claude Haiku 4.5, GLM-5.1, Kimi K2.6 / K2.5, MiniMax-M2.7, and DeepSeek V4 Pro / Flash.",
      },
    ],
    intro:
      "VM0 Managed is the fastest way to put an agent into production. You don't bring an API key, you don't sign up with a vendor, and you don't think about provider quotas — you just pick a model and run. The pool spans Anthropic, Z.AI, Moonshot, MiniMax, and DeepSeek, all routed through the same firewall that protects every VM0 run.",
    detailHeading: "Run agents on VM0 Managed — no API key required",
    metaDescription:
      "Run AI agents on Claude, GLM, Kimi, MiniMax, or DeepSeek without an API key. VM0 Managed pools provider keys behind a firewall and bills through your plan.",
  },

  "anthropic-api-key": {
    displayName: "Anthropic",
    tagline:
      "Bring your own Anthropic API key to run Claude Opus 4.7, Sonnet 4.6, and Haiku 4.5 on VM0 with vendor-direct billing.",
    bestFor: "max-quality",
    chinaAccessible: false,
    costBand: "$$$",
    authLabel: "Anthropic API key",
    strengths: [
      "Direct API access — newest Claude models the day they ship",
      "Highest reasoning quality on tool-use, code-edit, and long-horizon agent loops",
      "Native prompt caching reduces cost on repeated system prompts and tool definitions",
    ],
    tradeoffs: [
      "Highest list-price among supported providers; mitigate with prompt caching and Sonnet routing",
      "Not directly reachable from China without a proxy — choose Moonshot, GLM, or DeepSeek for China-region deployments",
    ],
    whenToChoose:
      "Choose Anthropic direct when you need the strongest reasoning model available, want vendor-direct invoicing, or rely on day-zero access to new Claude releases.",
    evaluation: [
      {
        scenario: "tool-routing",
        rating: "excellent",
        notes:
          "Claude Sonnet 4.6 picks the right tool with the right arguments more reliably than any other model in our internal evaluation.",
      },
      {
        scenario: "long-context",
        rating: "excellent",
        notes:
          "Claude Opus 4.7 maintains coherence across 200k+ token agent histories without drift.",
      },
      {
        scenario: "code-edit",
        rating: "excellent",
        notes:
          "Opus 4.7 writes the cleanest first-attempt patches; Sonnet 4.6 is fast enough to be the default.",
      },
      {
        scenario: "agent-loop",
        rating: "excellent",
        notes:
          "Lowest retry rate and step count to completion in long-running runs.",
      },
    ],
    faqs: [
      {
        question: "Where do I get an Anthropic API key?",
        answer:
          "Sign up at console.anthropic.com, create a workspace, and generate an API key under Settings → Keys. Paste it into VM0 Settings → Model Providers.",
      },
      {
        question: "Does VM0 see my Anthropic API key?",
        answer:
          "Your key is stored encrypted at the platform layer and never enters the agent sandbox. The VM0 firewall injects an authorization header on outbound calls to api.anthropic.com so the sandbox cannot read it.",
      },
      {
        question: "Can I use prompt caching with Anthropic on VM0?",
        answer:
          "Yes. VM0 routes requests through the standard Anthropic Messages API, so prompt caching works automatically on system prompts and tool definitions that exceed the cache threshold.",
      },
    ],
    intro:
      "Connect your own Anthropic API key to run Claude Opus 4.7, Sonnet 4.6, and Haiku 4.5 on VM0 agents. This is the path to maximum quality, day-zero access to new Claude releases, and vendor-direct billing.",
    detailHeading: "Run Claude on VM0 — Opus 4.7, Sonnet 4.6, Haiku 4.5",
    metaDescription:
      "Connect Anthropic to VM0 and run Claude Opus 4.7, Sonnet 4.6, and Haiku 4.5 agents with vendor-direct billing. Highest reasoning quality, prompt caching supported.",
  },

  "claude-code-oauth-token": {
    displayName: "Claude Code (OAuth)",
    tagline:
      "Use your Claude Pro or Max subscription to run agents on VM0 — no per-token billing, just sign in with your Anthropic account.",
    bestFor: "personal-pro",
    chinaAccessible: false,
    costBand: "free-with-plan",
    authLabel: "OAuth (Pro / Max)",
    strengths: [
      "Use your existing Claude Pro or Max subscription — no per-token bill",
      "Same Claude model lineup as the Anthropic API: Opus 4.7, Sonnet 4.6, Haiku 4.5",
      "Token expires after one year — set-and-forget for personal projects",
    ],
    tradeoffs: [
      "Subject to Pro / Max usage limits, not the higher API quotas",
      "Single-user — share-with-team workflows should use the Anthropic API key option instead",
    ],
    whenToChoose:
      "Pick Claude Code OAuth when you already pay for Claude Pro or Max and want to run personal agents without setting up a separate API billing relationship.",
    evaluation: [
      {
        scenario: "tool-routing",
        rating: "excellent",
        notes:
          "Identical model behaviour to Anthropic API — the difference is auth, not inference.",
      },
      {
        scenario: "cost-efficiency",
        rating: "excellent",
        notes:
          "If you already have a Pro/Max plan, marginal cost per agent run is zero.",
      },
      {
        scenario: "agent-loop",
        rating: "good",
        notes:
          "Pro/Max plans throttle sustained throughput — long batch runs hit limits faster than the API tier.",
      },
    ],
    faqs: [
      {
        question: "How do I get a Claude Code OAuth token?",
        answer:
          "Run `claude setup-token` in the Claude Code CLI. It prints a token starting with `sk-ant-oat01-`. Paste it into VM0 Settings → Model Providers.",
      },
      {
        question: "Do I need Claude Pro or Max?",
        answer:
          "Yes. The OAuth token is tied to a Claude Pro or Max subscription. If you don't have one, use the Anthropic API key option or VM0 Managed.",
      },
      {
        question: "How long does the OAuth token last?",
        answer:
          "Tokens are valid for one year. You'll need to re-run `claude setup-token` and update the secret in VM0 when it expires.",
      },
    ],
    intro:
      "If you already have a Claude Pro or Max plan, you can sign agents in with an OAuth token instead of an API key. Same Claude models, no separate billing.",
    detailHeading: "Run Claude on VM0 with your Pro or Max subscription",
    metaDescription:
      "Connect Claude Code OAuth to VM0 to run agents on your Claude Pro or Max subscription. No per-token billing — same Opus 4.7 / Sonnet 4.6 lineup as the API.",
  },

  "openrouter-api-key": {
    displayName: "OpenRouter",
    tagline:
      "One key, every model — route VM0 agents through OpenRouter to access Claude, GLM, Kimi, DeepSeek, and MiniMax with a single billing relationship.",
    bestFor: "gateway",
    chinaAccessible: true,
    costBand: "$$",
    authLabel: "OpenRouter API key",
    strengths: [
      "One API key covers Claude, GLM, Kimi, DeepSeek, and MiniMax — switch models without adding new providers",
      "Reachable from China without a proxy",
      "Useful for cost arbitrage — OpenRouter often surfaces lower per-token rates than the upstream",
    ],
    tradeoffs: [
      "Adds a hop of latency vs. the upstream provider",
      "Not all upstream features (e.g. day-zero models, prompt-cache discounts) flow through immediately",
    ],
    whenToChoose:
      "Choose OpenRouter when you want to evaluate multiple models without setting up multiple billing relationships, or when you need a single key that works from any region.",
    evaluation: [
      {
        scenario: "tool-routing",
        rating: "excellent",
        notes:
          "Routes the same Claude weights as the Anthropic API; tool-routing fidelity is preserved.",
      },
      {
        scenario: "agent-loop",
        rating: "good",
        notes:
          "The extra gateway hop adds ~50–150ms p50 latency vs. the upstream provider — usually invisible inside an agent step.",
      },
      {
        scenario: "cost-efficiency",
        rating: "good",
        notes:
          "Often beats list price on Anthropic / DeepSeek; less differentiated for Kimi and MiniMax.",
      },
    ],
    faqs: [
      {
        question: "What models does OpenRouter give me?",
        answer:
          "Through VM0 you get the full Claude family (Opus 4.7 down to Haiku 4.5), GLM-5.1, Kimi K2.6 / K2.5, DeepSeek V4 Pro / Flash, and MiniMax-M2.7 — all behind a single API key.",
      },
      {
        question: "Is OpenRouter accessible from China?",
        answer:
          "Yes. OpenRouter's API endpoint is reachable from mainland China without a proxy.",
      },
      {
        question: "Can I use prompt caching through OpenRouter?",
        answer:
          "Some upstream cache features pass through, but the experience is less consistent than going direct. For caching-heavy workloads, prefer the Anthropic API key option.",
      },
    ],
    intro:
      "OpenRouter is a model gateway that fronts dozens of providers behind a single API key. On VM0 it's the simplest way to evaluate Claude, GLM, Kimi, DeepSeek, and MiniMax side-by-side without juggling billing relationships.",
    detailHeading: "Run Claude, GLM, Kimi, and DeepSeek on VM0 via OpenRouter",
    metaDescription:
      "Connect OpenRouter to VM0 to run Claude, GLM-5.1, Kimi K2.6, DeepSeek V4, and MiniMax agents with a single API key. China-accessible, multi-model gateway.",
  },

  "moonshot-api-key": {
    displayName: "Moonshot (Kimi)",
    tagline:
      "Run Kimi K2.6 and the Kimi K2 thinking models on VM0 — long context, China-region access, and a Claude-compatible API.",
    bestFor: "long-context",
    chinaAccessible: true,
    costBand: "$$",
    authLabel: "Moonshot API key",
    strengths: [
      "Kimi K2.6 ranks highest in our long-context (>500k tokens) recall evaluation",
      "Reachable from mainland China without a proxy — production-friendly for China-deployed agents",
      "Claude-compatible API surface lets VM0 plug it in with no agent code changes",
    ],
    tradeoffs: [
      "Tool-routing is good but trails Claude Sonnet 4.6 on multi-tool benchmarks",
      "Less prompt-caching maturity than the Anthropic API",
    ],
    whenToChoose:
      "Choose Moonshot when you need a very long context window, when your users are in China, or when you want a Kimi-series thinking model.",
    evaluation: [
      {
        scenario: "long-context",
        rating: "excellent",
        notes:
          "Kimi K2.6 is the top performer in our internal recall benchmark beyond 200k tokens.",
      },
      {
        scenario: "tool-routing",
        rating: "good",
        notes:
          "Reliable on simple tool flows; multi-tool routing accuracy lags Claude Sonnet 4.6.",
      },
      {
        scenario: "agent-loop",
        rating: "good",
        notes:
          "Stable across long runs; thinking variants help on hard reasoning steps at the cost of latency.",
      },
    ],
    faqs: [
      {
        question: "What Kimi models can I run on VM0?",
        answer:
          "Kimi K2.6, Kimi K2.5, Kimi K2 Thinking Turbo, and Kimi K2 Thinking — all via the Moonshot API key option.",
      },
      {
        question: "Is Moonshot reachable from China?",
        answer:
          "Yes. The Moonshot API endpoint is hosted in mainland China and is reachable without a proxy.",
      },
      {
        question: "Where do I get a Moonshot API key?",
        answer:
          "Sign in at platform.moonshot.ai, open Console → API Keys, and generate one. Paste it into VM0 Settings → Model Providers.",
      },
    ],
    intro:
      "Moonshot's Kimi family pairs an extremely long context window with native China-region reachability. On VM0 it's the strongest pick for agents that need to reason over hundreds of thousands of tokens or run inside the China firewall.",
    detailHeading: "Run Kimi K2.6 on VM0 — long-context agents, China-friendly",
    metaDescription:
      "Run Kimi K2.6 and Kimi K2 Thinking on VM0 with a Moonshot API key. Best-in-class long-context recall, reachable from mainland China, Claude-compatible API.",
  },

  "minimax-api-key": {
    displayName: "MiniMax",
    tagline:
      "Run MiniMax-M2.7 on VM0 — China-region access and a strong fit for specialised reasoning and multilingual workloads.",
    bestFor: "specialised",
    chinaAccessible: true,
    costBand: "$$",
    authLabel: "MiniMax API key",
    strengths: [
      "Strong on Chinese-language tasks and multilingual reasoning",
      "China-region API endpoint, no proxy required",
      "Generous default timeout makes it suitable for long agent steps",
    ],
    tradeoffs: [
      "Smaller model lineup than Anthropic or Moonshot",
      "Less third-party tooling and benchmark coverage to draw on",
    ],
    whenToChoose:
      "Choose MiniMax when your workload skews Chinese-language or multilingual, or when you want a second China-region option alongside Kimi or GLM.",
    evaluation: [
      {
        scenario: "tool-routing",
        rating: "good",
        notes:
          "Reliable on common Slack / GitHub / Notion tool flows.",
      },
      {
        scenario: "long-context",
        rating: "good",
        notes:
          "Solid recall up to ~128k tokens; Kimi remains the long-context leader for >200k.",
      },
      {
        scenario: "agent-loop",
        rating: "good",
        notes:
          "VM0 sets a 50-minute API timeout for MiniMax — long thinking steps complete reliably.",
      },
    ],
    faqs: [
      {
        question: "What MiniMax models can I run on VM0?",
        answer:
          "MiniMax-M2.7 and MiniMax-M2.1 via the MiniMax API key option.",
      },
      {
        question: "Where do I get a MiniMax API key?",
        answer:
          "Sign in at platform.minimax.io, open User Center → Basic Information → Interface Key, and generate one. Paste it into VM0 Settings → Model Providers.",
      },
      {
        question: "Is MiniMax accessible from China?",
        answer:
          "Yes. The MiniMax API is hosted in China and reachable without a proxy.",
      },
    ],
    intro:
      "MiniMax-M2.7 is a strong Chinese-language and multilingual reasoning model with a China-region endpoint. VM0's MiniMax integration sets a generous timeout so long thinking steps complete reliably.",
    detailHeading: "Run MiniMax-M2.7 on VM0 — China-region multilingual agents",
    metaDescription:
      "Run MiniMax-M2.7 and M2.1 agents on VM0 with a MiniMax API key. Strong on Chinese-language and multilingual tasks; reachable from mainland China.",
  },

  "deepseek-api-key": {
    displayName: "DeepSeek",
    tagline:
      "Run DeepSeek V4 Pro and V4 Flash on VM0 — the lowest-cost option in our supported lineup, with a Claude-compatible API.",
    bestFor: "cost-optimised",
    chinaAccessible: true,
    costBand: "$",
    authLabel: "DeepSeek API key",
    strengths: [
      "Lowest per-token cost of any supported provider — often 5–10× cheaper than Claude Opus",
      "Reachable from mainland China without a proxy",
      "Claude-compatible API means existing VM0 agents work without code changes",
    ],
    tradeoffs: [
      "Trails Claude Opus and Sonnet on multi-tool routing accuracy",
      "Best paired with simpler agent loops where cost matters more than peak quality",
    ],
    whenToChoose:
      "Choose DeepSeek when cost dominates the decision — high-volume support triage, batch summarisation, or any workload where Claude-tier reasoning is overkill.",
    evaluation: [
      {
        scenario: "cost-efficiency",
        rating: "excellent",
        notes:
          "DeepSeek V4 Flash is the cheapest model in our supported set by a wide margin.",
      },
      {
        scenario: "tool-routing",
        rating: "fair",
        notes:
          "Acceptable on single-tool flows; multi-tool accuracy is meaningfully behind Claude Sonnet 4.6.",
      },
      {
        scenario: "agent-loop",
        rating: "good",
        notes:
          "Stable across long runs when paired with clear tool definitions and a focused agent prompt.",
      },
    ],
    faqs: [
      {
        question: "What DeepSeek models can I run on VM0?",
        answer:
          "DeepSeek V4 Pro and DeepSeek V4 Flash. Flash is the default and is set up for low-cost, high-volume agent runs.",
      },
      {
        question: "How much cheaper is DeepSeek?",
        answer:
          "DeepSeek V4 Flash is typically 5–10× cheaper per token than Claude Opus 4.7 — your actual savings depend on prompt length and prompt-caching usage.",
      },
      {
        question: "Where do I get a DeepSeek API key?",
        answer:
          "Sign in at platform.deepseek.com, open API Keys, and generate one. Paste it into VM0 Settings → Model Providers.",
      },
    ],
    intro:
      "DeepSeek V4 is the cost lever in the VM0 model lineup. It speaks the same Anthropic-compatible API as Claude, so existing agents drop in unchanged — at a fraction of the cost.",
    detailHeading: "Run DeepSeek V4 on VM0 — cost-optimised AI agents",
    metaDescription:
      "Run DeepSeek V4 Pro and V4 Flash agents on VM0. The lowest-cost model option in our lineup, Claude-compatible API, reachable from China.",
  },

  "zai-api-key": {
    displayName: "Z.AI (GLM)",
    tagline:
      "Run GLM-5.1 and the GLM family on VM0 — strong reasoning, very long context, and a China-region endpoint.",
    bestFor: "china-region",
    chinaAccessible: true,
    costBand: "$",
    authLabel: "Z.AI API key",
    strengths: [
      "GLM-5.1 offers a 1M-token context window — useful for whole-repo or whole-knowledge-base agents",
      "China-region endpoint with no proxy required",
      "Cost-competitive with DeepSeek for general reasoning tasks",
    ],
    tradeoffs: [
      "Tool-routing accuracy trails Claude Sonnet 4.6",
      "Less mature prompt-caching story than Anthropic",
    ],
    whenToChoose:
      "Choose Z.AI when you need a very large context window in China, want a cost-competitive alternative to DeepSeek, or are standardising on the GLM family.",
    evaluation: [
      {
        scenario: "long-context",
        rating: "excellent",
        notes:
          "GLM-5.1 advertises a 1M-token window — comparable to Kimi K2.6 for whole-repository agents.",
      },
      {
        scenario: "tool-routing",
        rating: "good",
        notes:
          "Reliable on common multi-tool flows; trails Claude Sonnet 4.6 on edge cases.",
      },
      {
        scenario: "cost-efficiency",
        rating: "excellent",
        notes:
          "GLM-4.5 Air is one of the cheapest options in the supported set.",
      },
    ],
    faqs: [
      {
        question: "What GLM models can I run on VM0?",
        answer:
          "GLM-5.1, GLM-5, GLM-4.7, and GLM-4.5 Air via the Z.AI API key option.",
      },
      {
        question: "How big is the GLM-5.1 context window?",
        answer:
          "GLM-5.1 supports up to a 1M-token context window — strong for whole-repository or whole-knowledge-base agents.",
      },
      {
        question: "Where do I get a Z.AI API key?",
        answer:
          "Sign in at z.ai/model-api, generate an API key, and paste it into VM0 Settings → Model Providers.",
      },
    ],
    intro:
      "Z.AI's GLM family (GLM-5.1, GLM-5, GLM-4.7, GLM-4.5 Air) brings an unusually large context window and a China-region endpoint. On VM0 it's a strong pick for whole-codebase agents and cost-sensitive China-region workloads.",
    detailHeading: "Run GLM-5.1 on VM0 — 1M-token agents from a China endpoint",
    metaDescription:
      "Run GLM-5.1 and the GLM family on VM0 with a Z.AI API key. Up to 1M-token context window, China-region access, cost-competitive with DeepSeek.",
  },

  "vercel-ai-gateway": {
    displayName: "Vercel AI Gateway",
    tagline:
      "Route VM0 agents through Vercel AI Gateway to consolidate spend with Vercel and use a single API key for Claude, Kimi, GLM, and MiniMax.",
    bestFor: "gateway",
    chinaAccessible: false,
    costBand: "$$",
    authLabel: "Vercel AI Gateway key",
    strengths: [
      "Consolidate model spend on your existing Vercel invoice",
      "Single key fronts Claude, Kimi, GLM, and MiniMax",
      "Convenient when you're already a heavy Vercel customer with vendor-management constraints",
    ],
    tradeoffs: [
      "Adds latency vs. the upstream provider",
      "Day-zero model availability lags the upstream",
    ],
    whenToChoose:
      "Choose Vercel AI Gateway when you're already a Vercel customer and need to consolidate AI spend on a single invoice, or when corporate procurement has Vercel approved but not other AI providers.",
    evaluation: [
      {
        scenario: "tool-routing",
        rating: "excellent",
        notes:
          "Routes the same upstream Claude weights — tool-routing fidelity is preserved.",
      },
      {
        scenario: "agent-loop",
        rating: "good",
        notes:
          "Adds a gateway hop; latency overhead is similar to OpenRouter.",
      },
    ],
    faqs: [
      {
        question: "What models does Vercel AI Gateway expose on VM0?",
        answer:
          "Claude Opus 4.6 / 4.5, Sonnet 4.6 / 4.5, Haiku 4.5, Kimi K2.6 / K2.5, MiniMax-M2.5, and GLM-5 Turbo.",
      },
      {
        question: "Where do I get a Vercel AI Gateway key?",
        answer:
          "Generate one in your Vercel dashboard under AI Gateway. Paste it into VM0 Settings → Model Providers.",
      },
    ],
    intro:
      "Vercel AI Gateway is a model gateway aimed at teams who want to consolidate AI spend on their Vercel invoice. VM0 plugs in via the gateway's Anthropic-compatible interface so existing agents work without changes.",
    detailHeading: "Run Claude on VM0 via Vercel AI Gateway",
    metaDescription:
      "Connect Vercel AI Gateway to VM0 to run Claude, Kimi, GLM, and MiniMax agents on a single key. Consolidate AI spend on your Vercel invoice.",
  },

  // Hidden providers (not user-selectable) — exhaustive content for type
  // safety, never rendered on the marketing site.
  "aws-bedrock": {
    displayName: "AWS Bedrock",
    tagline: "Enterprise — contact sales.",
    bestFor: "specialised",
    chinaAccessible: false,
    costBand: "$$$$",
    authLabel: "AWS",
    strengths: [],
    tradeoffs: [],
    whenToChoose: "",
    evaluation: [],
    faqs: [],
    intro: "",
    detailHeading: "",
    metaDescription: "",
  },
  "azure-foundry": {
    displayName: "Azure Foundry",
    tagline: "Enterprise — contact sales.",
    bestFor: "specialised",
    chinaAccessible: false,
    costBand: "$$$$",
    authLabel: "Azure",
    strengths: [],
    tradeoffs: [],
    whenToChoose: "",
    evaluation: [],
    faqs: [],
    intro: "",
    detailHeading: "",
    metaDescription: "",
  },
};

// Compile-time guarantee: every provider in the contract has content.
const _exhaustiveContentCheck: Record<ProviderSlug, ProviderContent> = CONTENT;
void _exhaustiveContentCheck;

// ---------------------------------------------------------------------------
// Public lookups
// ---------------------------------------------------------------------------

export interface ProviderViewModel {
  slug: ProviderSlug;
  /** Contract `label` field (admin-grade name). */
  contractLabel: string;
  /** Display name from CONTENT (marketing-friendly). */
  displayName: string;
  models: readonly string[];
  defaultModel: string | undefined;
  visual: ProviderVisual;
  content: ProviderContent;
}

function readModels(slug: ProviderSlug): readonly string[] {
  const config = MODEL_PROVIDER_TYPES[slug];
  return "models" in config ? config.models : [];
}

function readDefaultModel(slug: ProviderSlug): string | undefined {
  const config = MODEL_PROVIDER_TYPES[slug];
  if (!("defaultModel" in config)) return undefined;
  const dm = config.defaultModel;
  return dm && dm.length > 0 ? dm : undefined;
}

export function getProvider(slug: string): ProviderViewModel | null {
  if (!(PROVIDER_SLUGS as string[]).includes(slug)) return null;
  const typed = slug as ProviderSlug;
  const config = MODEL_PROVIDER_TYPES[typed];
  return {
    slug: typed,
    contractLabel: config.label,
    displayName: CONTENT[typed].displayName,
    models: readModels(typed),
    defaultModel: readDefaultModel(typed),
    visual: VISUALS[typed],
    content: CONTENT[typed],
  };
}

export function getAllProviders(): ProviderViewModel[] {
  return PROVIDER_SLUGS.map((slug) => {
    const provider = getProvider(slug);
    if (!provider) {
      throw new Error(`Missing provider view-model for ${slug}`);
    }
    return provider;
  });
}

// Stable display order on the hub. Hand-curated so the most important
// providers lead — VM0 Managed first (default path), then quality / cost /
// region groupings.
const HUB_ORDER: ProviderSlug[] = [
  "vm0",
  "anthropic-api-key",
  "claude-code-oauth-token",
  "moonshot-api-key",
  "deepseek-api-key",
  "zai-api-key",
  "minimax-api-key",
  "openrouter-api-key",
  "vercel-ai-gateway",
];

export function getOrderedProviders(): ProviderViewModel[] {
  const all = getAllProviders();
  const bySlug = new Map(
    all.map((p) => {
      return [p.slug, p];
    }),
  );
  const ordered: ProviderViewModel[] = [];
  for (const slug of HUB_ORDER) {
    const provider = bySlug.get(slug);
    if (provider) ordered.push(provider);
  }
  // Append any selectable providers that weren't in HUB_ORDER (defensive — if
  // someone adds a provider to the contract without updating HUB_ORDER, it
  // still shows up at the end rather than vanishing).
  for (const provider of all) {
    if (!HUB_ORDER.includes(provider.slug)) {
      ordered.push(provider);
    }
  }
  return ordered;
}
