// ---------------------------------------------------------------------------
// Models. Built-in lineup shown on /models and /models/[slug].
//
// Reasoning models: order, multipliers, pricing, and routing facts mirror the
// platform at:
//   - turbo/packages/api-contracts/src/contracts/model-providers.ts
//     (VM0_MODEL_TO_PROVIDER, MODEL_PROVIDER_TYPES)
//   - turbo/apps/platform/.../settings/provider-ui-config.ts
//     (VM0_MODEL_CREDIT_MULTIPLIER)
//   - turbo/apps/web/scripts/dev-seed.ts (MODEL_PRICING. USD per 1M tokens)
//
// Generation models (image, video, audio): per-unit pricing mirrors the same
// dev-seed.ts table (USD per image / megapixel / video-second / audio-second).
//
// Translatable content lives in messages/<locale>.json under
// models.content.<slug>.* — see the use-cases page for the same pattern.
// ---------------------------------------------------------------------------

const VENDOR_ICONS: Readonly<Record<string, string>> = {
  Anthropic: "/assets/connectors/anthropic.svg",
  OpenAI: "/assets/connectors/openai.svg",
  Google: "/assets/connectors/gemini.svg",
  "Z.AI": "/assets/connectors/chatglm.svg",
  Moonshot: "/assets/connectors/kimi.svg",
  DeepSeek: "/assets/connectors/deepseek.svg",
  MiniMax: "/assets/connectors/minimax.svg",
};

export function vendorIconPath(vendor: string): string | null {
  return VENDOR_ICONS[vendor] ?? null;
}

type ModelCategory = "reasoning" | "image" | "video" | "audio";

interface ModelPricing {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  /** `null` when the upstream provider does not bill cache writes. */
  cacheWriteUsd: number | null;
}

export type GenerationPricingUnit =
  | "image"
  | "megapixel"
  | "video-second"
  | "audio-second";

interface GenerationPricing {
  unit: GenerationPricingUnit;
  priceUsd: number;
  /** Free-form qualifier shown next to the price, e.g. "1080p" or "low/standard tier". */
  note?: string;
}

interface BaseModelEntry {
  slug: string;
  modelId: string;
  name: string;
  vendor: string;
  category: ModelCategory;
  modalities: string[];
  releasedToVm0: string;

  /** Model names of comparison targets (used in heading template and as content lookup keys). */
  comparisonSlugs: string[];
  /** Slugs of alternative models for the "Alternatives" card row. */
  alternativeSlugs: string[];
}

export interface ReasoningModelEntry extends BaseModelEntry {
  category: "reasoning";
  multiplier: number;
  contextWindowK: number;
  promptCaching: boolean;
  pricing: ModelPricing;
  vm0Tier: "core" | "cost-saving";
  vm0TimeoutMin?: number;
  byoKeyLabel: string;
  defaultFor: string[];
}

export interface GenerationModelEntry extends BaseModelEntry {
  category: "image" | "video" | "audio";
  generationPricing: GenerationPricing;
}

export type ModelEntry = ReasoningModelEntry | GenerationModelEntry;

export function isReasoningModel(m: ModelEntry): m is ReasoningModelEntry {
  return m.category === "reasoning";
}

export const MODELS: ModelEntry[] = [
  {
    slug: "claude-opus-4-7",
    modelId: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    vendor: "Anthropic",
    category: "reasoning",
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
    alternativeSlugs: ["claude-sonnet-4-6", "kimi-k2-6", "deepseek-v4-pro"],
  },

  {
    slug: "claude-opus-4-6",
    modelId: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    vendor: "Anthropic",
    category: "reasoning",
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
    alternativeSlugs: ["claude-opus-4-7", "claude-sonnet-4-6", "kimi-k2-6"],
  },

  {
    slug: "gpt-5-5",
    modelId: "gpt-5.5",
    name: "GPT-5.5",
    vendor: "OpenAI",
    category: "reasoning",
    multiplier: 2,
    contextWindowK: 400,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "April 2026",
    pricing: {
      inputUsd: 5,
      outputUsd: 30,
      cacheReadUsd: 0.5,
      cacheWriteUsd: null,
    },
    vm0Tier: "core",
    byoKeyLabel: "OpenAI API key",
    defaultFor: ["OpenAI", "ChatGPT (Codex)"],
    comparisonSlugs: ["GPT-5.4", "Claude Opus 4.7", "Gemini 3 Pro"],
    alternativeSlugs: ["gpt-5-4", "claude-opus-4-7", "claude-sonnet-4-6"],
  },

  {
    slug: "claude-sonnet-4-6",
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    vendor: "Anthropic",
    category: "reasoning",
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
    slug: "gpt-5-4",
    modelId: "gpt-5.4",
    name: "GPT-5.4",
    vendor: "OpenAI",
    category: "reasoning",
    multiplier: 1,
    contextWindowK: 400,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "April 2026",
    pricing: {
      inputUsd: 2.5,
      outputUsd: 15,
      cacheReadUsd: 0.25,
      cacheWriteUsd: null,
    },
    vm0Tier: "core",
    byoKeyLabel: "OpenAI API key",
    defaultFor: [],
    comparisonSlugs: ["GPT-5.5", "Claude Sonnet 4.6", "GPT-5.4 Mini"],
    alternativeSlugs: ["gpt-5-5", "gpt-5-4-mini", "claude-sonnet-4-6"],
  },

  {
    slug: "glm-5-1",
    modelId: "glm-5.1",
    name: "GLM-5.1",
    vendor: "Z.AI",
    category: "reasoning",
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
    alternativeSlugs: ["kimi-k2-6", "deepseek-v4-pro", "claude-sonnet-4-6"],
  },

  {
    slug: "claude-haiku-4-5",
    modelId: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    vendor: "Anthropic",
    category: "reasoning",
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
      "minimax-m2-7",
    ],
  },

  {
    slug: "gpt-5-4-mini",
    modelId: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    vendor: "OpenAI",
    category: "reasoning",
    multiplier: 0.3,
    contextWindowK: 400,
    promptCaching: true,
    modalities: ["Text", "Vision", "Code"],
    releasedToVm0: "April 2026",
    pricing: {
      inputUsd: 0.75,
      outputUsd: 4.5,
      cacheReadUsd: 0.075,
      cacheWriteUsd: null,
    },
    vm0Tier: "cost-saving",
    byoKeyLabel: "OpenAI API key",
    defaultFor: [],
    comparisonSlugs: ["GPT-5.4", "Claude Haiku 4.5", "DeepSeek V4 Flash"],
    alternativeSlugs: ["gpt-5-4", "claude-haiku-4-5", "deepseek-v4-flash"],
  },

  {
    slug: "kimi-k2-6",
    modelId: "kimi-k2.6",
    name: "Kimi K2.6",
    vendor: "Moonshot",
    category: "reasoning",
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
    alternativeSlugs: ["kimi-k2-5", "glm-5-1", "deepseek-v4-pro"],
  },

  {
    slug: "deepseek-v4-pro",
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    vendor: "DeepSeek",
    category: "reasoning",
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
    alternativeSlugs: ["deepseek-v4-flash", "claude-sonnet-4-6", "kimi-k2-6"],
  },

  {
    slug: "kimi-k2-5",
    modelId: "kimi-k2.5",
    name: "Kimi K2.5",
    vendor: "Moonshot",
    category: "reasoning",
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
    alternativeSlugs: ["kimi-k2-6", "glm-5-1", "deepseek-v4-pro"],
  },

  {
    slug: "minimax-m2-7",
    modelId: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    vendor: "MiniMax",
    category: "reasoning",
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
    alternativeSlugs: ["kimi-k2-6", "deepseek-v4-flash", "claude-haiku-4-5"],
  },

  {
    slug: "deepseek-v4-flash",
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    vendor: "DeepSeek",
    category: "reasoning",
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
    alternativeSlugs: ["deepseek-v4-pro", "claude-haiku-4-5", "minimax-m2-7"],
  },

  // -------------------------------------------------------------------------
  // Image generation models.
  // -------------------------------------------------------------------------

  {
    slug: "gpt-image-2",
    modelId: "gpt-image-2",
    name: "GPT Image 2",
    vendor: "OpenAI",
    category: "image",
    modalities: ["Image", "Text-to-image", "Image edit"],
    releasedToVm0: "April 2026",
    generationPricing: {
      unit: "image",
      priceUsd: 0.064,
      note: "Medium standard tier (1024x1024)",
    },
    comparisonSlugs: ["GPT Image 1", "SeedDream 4"],
    alternativeSlugs: ["gpt-image-1", "seedream-4"],
  },

  {
    slug: "gpt-image-1",
    modelId: "gpt-image-1",
    name: "GPT Image 1",
    vendor: "OpenAI",
    category: "image",
    modalities: ["Image", "Text-to-image", "Image edit"],
    releasedToVm0: "April 2026",
    generationPricing: {
      unit: "image",
      priceUsd: 0.05,
      note: "Medium standard tier (1024×1024)",
    },
    comparisonSlugs: ["SeedDream 4", "Flux Pro 1.1 Ultra"],
    alternativeSlugs: ["flux-pro-1-1-ultra", "seedream-4"],
  },

  {
    slug: "flux-pro-1-1-ultra",
    modelId: "fal-ai/flux-pro/v1.1-ultra",
    name: "Flux Pro 1.1 Ultra",
    vendor: "Black Forest Labs",
    category: "image",
    modalities: ["Image", "Text-to-image"],
    releasedToVm0: "April 2026",
    generationPricing: {
      unit: "image",
      priceUsd: 0.072,
      note: "Per generated image",
    },
    comparisonSlugs: ["GPT Image 1", "SeedDream 4"],
    alternativeSlugs: ["gpt-image-1", "seedream-4"],
  },

  {
    slug: "seedream-4",
    modelId: "fal-ai/bytedance/seedream/v4/text-to-image",
    name: "SeedDream 4",
    vendor: "ByteDance",
    category: "image",
    modalities: ["Image", "Text-to-image"],
    releasedToVm0: "April 2026",
    generationPricing: {
      unit: "image",
      priceUsd: 0.036,
      note: "Per generated image",
    },
    comparisonSlugs: ["GPT Image 1", "Flux Pro 1.1 Ultra"],
    alternativeSlugs: ["gpt-image-1", "flux-pro-1-1-ultra"],
  },

  // -------------------------------------------------------------------------
  // Video generation models.
  // -------------------------------------------------------------------------

  {
    slug: "veo-3-1-fast",
    modelId: "veo3.1-fast",
    name: "Veo 3.1 Fast",
    vendor: "Google",
    category: "video",
    modalities: ["Video", "Text-to-video", "Image-to-video", "Audio"],
    releasedToVm0: "April 2026",
    generationPricing: {
      unit: "video-second",
      priceUsd: 0.15,
      note: "Approximate, 720p with native audio",
    },
    comparisonSlugs: ["Kling V3 4K", "Dreamina Seedance 2.0"],
    alternativeSlugs: ["kling-v3-4k", "dreamina-seedance-2-0"],
  },

  {
    slug: "kling-v3-4k",
    modelId: "kling-v3-4k",
    name: "Kling V3 4K",
    vendor: "Kuaishou",
    category: "video",
    modalities: ["Video", "Text-to-video", "Image-to-video"],
    releasedToVm0: "April 2026",
    generationPricing: {
      unit: "video-second",
      priceUsd: 0.28,
      note: "Approximate, 4K standard generation",
    },
    comparisonSlugs: ["Veo 3.1 Fast", "Dreamina Seedance 2.0"],
    alternativeSlugs: ["veo-3-1-fast", "dreamina-seedance-2-0"],
  },

  {
    slug: "dreamina-seedance-2-0",
    modelId: "dreamina-seedance-2-0-260128",
    name: "Dreamina Seedance 2.0",
    vendor: "ByteDance",
    category: "video",
    modalities: ["Video", "Text-to-video", "Image-to-video"],
    releasedToVm0: "April 2026",
    generationPricing: {
      unit: "video-second",
      priceUsd: 0.05,
      note: "Approximate, 1080p with image conditioning",
    },
    comparisonSlugs: ["Veo 3.1 Fast", "Kling V3 4K"],
    alternativeSlugs: ["veo-3-1-fast", "kling-v3-4k"],
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

// Per-generation-model onboarding prompts. The CTA on each image/video detail
// page deep-links into the app's onboarding flow with this prompt prefilled,
// so a first-time visitor lands on a chat that can immediately run the model
// without having to write their own prompt. Mentioning the model id in plain
// English lets the agent reliably pass it as `--model` when it calls the
// built-in generation tool, while keeping the surface copy natural.
const GENERATION_CTA_PROMPTS: Readonly<Record<string, string>> = {
  "gpt-image-2":
    "Generate an illustration of a cute cat using the gpt-image-2 model.",
  "gpt-image-1":
    "Generate an illustration of a cute cat using the gpt-image-1 model.",
  "flux-pro-1-1-ultra":
    "Generate a photorealistic studio portrait of a cat using the flux-pro-1.1-ultra model.",
  "seedream-4":
    "Generate a photorealistic shot of a cat sitting in a sunny window using the seedream4 model.",
  "veo-3-1-fast":
    "Generate a short cinematic video of a cat stretching on a sunlit windowsill using the veo3.1-fast model.",
  "kling-v3-4k":
    "Generate a stylized 4K video of a cat walking through a neon-lit alley using the kling-v3-4k model.",
  "dreamina-seedance-2-0":
    "Generate a smooth tracking video of a cat exploring a flower garden using the dreamina-seedance-2.0 model.",
};

export function getModelCtaUrl(model: ModelEntry, appUrl: string): string {
  const prompt = GENERATION_CTA_PROMPTS[model.slug];
  if (!prompt) return appUrl;
  return `${appUrl}/onboarding?prompt=${encodeURIComponent(prompt)}`;
}
