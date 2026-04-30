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
// Translatable content lives in messages/<locale>.json under
// models.content.<slug>.* — see the use-cases page for the same pattern.
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

export interface ModelEntry {
  slug: string;
  modelId: string;
  name: string;
  vendor: string;
  multiplier: number;

  contextWindowK: number;
  promptCaching: boolean;
  modalities: string[];
  releasedToVm0: string;

  pricing: ModelPricing;
  vm0Tier: "core" | "cost-saving";
  vm0TimeoutMin?: number;
  byoKeyLabel: string;
  defaultFor: string[];

  /** Model names of comparison targets (used in heading template and as content lookup keys). */
  comparisonSlugs: string[];
  /** Slugs of alternative models for the "Alternatives" card row. */
  alternativeSlugs: string[];
}

export const MODELS: ModelEntry[] = [
  {
    slug: "claude-opus-4-7",
    modelId: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    vendor: "Anthropic",
    multiplier: 1.7,
    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "April 17, 2026",
    pricing: {
      inputUsd: 5,
      outputUsd: 25,
      cacheReadUsd: 0.5,
      cacheWriteUsd: 6.25,
    },
    vm0Tier: "core",
    byoKeyLabel: "Anthropic API key",
    defaultFor: [],
    comparisonSlugs: [
      "Claude Sonnet 4.6",
      "Claude Opus 4.6",
      "Kimi K2.6",
      "DeepSeek V4 Pro",
      "GPT-5.2 / Gemini 3 Pro",
    ],
    alternativeSlugs: ["claude-sonnet-4-6", "kimi-k2.6", "deepseek-v4-pro"],
  },

  {
    slug: "claude-opus-4-6",
    modelId: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    vendor: "Anthropic",
    multiplier: 1.7,
    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "Available since launch",
    pricing: {
      inputUsd: 15,
      outputUsd: 75,
      cacheReadUsd: 1.5,
      cacheWriteUsd: 18.75,
    },
    vm0Tier: "core",
    byoKeyLabel: "Anthropic API key",
    defaultFor: ["Anthropic API key", "Claude Code OAuth"],
    comparisonSlugs: ["Claude Opus 4.7", "Claude Sonnet 4.6", "Kimi K2.6"],
    alternativeSlugs: ["claude-opus-4-7", "claude-sonnet-4-6", "kimi-k2.6"],
  },

  {
    slug: "claude-sonnet-4-6",
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    vendor: "Anthropic",
    multiplier: 1,
    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "Available since launch",
    pricing: {
      inputUsd: 3,
      outputUsd: 15,
      cacheReadUsd: 0.3,
      cacheWriteUsd: 3.75,
    },
    vm0Tier: "core",
    byoKeyLabel: "Anthropic API key",
    defaultFor: ["VM0 Managed"],
    comparisonSlugs: ["Claude Opus 4.7", "Claude Haiku 4.5", "DeepSeek V4 Pro"],
    alternativeSlugs: [
      "claude-opus-4-7",
      "claude-haiku-4-5",
      "deepseek-v4-pro",
    ],
  },

  {
    slug: "glm-5.1",
    modelId: "glm-5.1",
    name: "GLM-5.1",
    vendor: "Z.AI",
    multiplier: 0.4,
    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    releasedToVm0: "April 2026",
    pricing: {
      inputUsd: 1.4,
      outputUsd: 4.4,
      cacheReadUsd: 0.26,
      cacheWriteUsd: 1.4,
    },
    vm0Tier: "cost-saving",
    vm0TimeoutMin: 50,
    byoKeyLabel: "Z.AI API key",
    defaultFor: ["Z.AI"],
    comparisonSlugs: ["Kimi K2.6", "Claude Sonnet 4.6", "DeepSeek V4 Pro"],
    alternativeSlugs: ["kimi-k2.6", "deepseek-v4-pro", "claude-sonnet-4-6"],
  },

  {
    slug: "claude-haiku-4-5",
    modelId: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    vendor: "Anthropic",
    multiplier: 0.3,
    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "Available since launch",
    pricing: {
      inputUsd: 1,
      outputUsd: 5,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 1.25,
    },
    vm0Tier: "cost-saving",
    byoKeyLabel: "Anthropic API key",
    defaultFor: [],
    comparisonSlugs: ["Claude Sonnet 4.6", "DeepSeek V4 Flash", "MiniMax M2.7"],
    alternativeSlugs: [
      "claude-sonnet-4-6",
      "deepseek-v4-flash",
      "minimax-m2.7",
    ],
  },

  {
    slug: "kimi-k2.6",
    modelId: "kimi-k2.6",
    name: "Kimi K2.6",
    vendor: "Moonshot",
    multiplier: 0.3,
    contextWindowK: 256,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "April 2026",
    pricing: {
      inputUsd: 0.6,
      outputUsd: 3,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0.6,
    },
    vm0Tier: "cost-saving",
    byoKeyLabel: "Moonshot API key",
    defaultFor: ["Moonshot"],
    comparisonSlugs: ["GLM-5.1", "Claude Sonnet 4.6", "Kimi K2.5"],
    alternativeSlugs: ["kimi-k2.5", "glm-5.1", "deepseek-v4-pro"],
  },

  {
    slug: "deepseek-v4-pro",
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    vendor: "DeepSeek",
    multiplier: 0.3,
    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    releasedToVm0: "April 24, 2026",
    pricing: {
      inputUsd: 1.74,
      outputUsd: 3.48,
      cacheReadUsd: 0.145,
      cacheWriteUsd: null,
    },
    vm0Tier: "cost-saving",
    vm0TimeoutMin: 10,
    byoKeyLabel: "DeepSeek API key",
    defaultFor: [],
    comparisonSlugs: ["DeepSeek V4 Flash", "Claude Sonnet 4.6", "Kimi K2.6"],
    alternativeSlugs: ["deepseek-v4-flash", "claude-sonnet-4-6", "kimi-k2.6"],
  },

  {
    slug: "kimi-k2.5",
    modelId: "kimi-k2.5",
    name: "Kimi K2.5",
    vendor: "Moonshot",
    multiplier: 0.2,
    contextWindowK: 256,
    promptCaching: true,
    modalities: ["Text", "Image", "Code"],
    releasedToVm0: "Available since launch",
    pricing: {
      inputUsd: 0.6,
      outputUsd: 3,
      cacheReadUsd: 0.1,
      cacheWriteUsd: 0.6,
    },
    vm0Tier: "cost-saving",
    byoKeyLabel: "Moonshot API key",
    defaultFor: [],
    comparisonSlugs: ["Kimi K2.6", "DeepSeek V4 Pro"],
    alternativeSlugs: ["kimi-k2.6", "glm-5.1", "deepseek-v4-pro"],
  },

  {
    slug: "minimax-m2.7",
    modelId: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    vendor: "MiniMax",
    multiplier: 0.1,
    contextWindowK: 200,
    promptCaching: true,
    modalities: ["Text", "Code"],
    releasedToVm0: "Available since launch",
    pricing: {
      inputUsd: 0.3,
      outputUsd: 1.2,
      cacheReadUsd: 0.06,
      cacheWriteUsd: 0.375,
    },
    vm0Tier: "cost-saving",
    vm0TimeoutMin: 50,
    byoKeyLabel: "MiniMax API key",
    defaultFor: ["MiniMax"],
    comparisonSlugs: ["Kimi K2.6", "DeepSeek V4 Flash", "GLM-5.1"],
    alternativeSlugs: ["kimi-k2.6", "deepseek-v4-flash", "claude-haiku-4-5"],
  },

  {
    slug: "deepseek-v4-flash",
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    vendor: "DeepSeek",
    multiplier: 0.02,
    contextWindowK: 1000,
    promptCaching: true,
    modalities: ["Text", "Code"],
    releasedToVm0: "April 24, 2026",
    pricing: {
      inputUsd: 0.14,
      outputUsd: 0.28,
      cacheReadUsd: 0.028,
      cacheWriteUsd: null,
    },
    vm0Tier: "cost-saving",
    vm0TimeoutMin: 10,
    byoKeyLabel: "DeepSeek API key",
    defaultFor: ["DeepSeek"],
    comparisonSlugs: ["DeepSeek V4 Pro", "Claude Haiku 4.5", "MiniMax M2.7"],
    alternativeSlugs: ["deepseek-v4-pro", "claude-haiku-4-5", "minimax-m2.7"],
  },
];

export const MODEL_SLUGS = MODELS.map((m) => {
  return m.slug;
});

export function getModelBySlug(slug: string): ModelEntry | undefined {
  return MODELS.find((m) => {
    return m.slug === slug;
  });
}
