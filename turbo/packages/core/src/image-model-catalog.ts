/**
 * Catalog of prompt-based built-in image generation models.
 *
 * Provider request shapes, pricing, and model-specific parameters stay in the
 * API service. Promptless transforms are deliberately excluded because they
 * cannot act as chat defaults.
 */
import {
  IMAGE_MODEL_IDS,
  type ImageModelId,
} from "@okouai/api-contracts/contracts/image-models";

interface ImageModelConfig {
  /** Value accepted by the CLI's `--model` flag. */
  readonly alias: string;
  /** Human-facing name for pickers. */
  readonly label: string;
  /** Compact label used when the model is shown as a sibling variant. */
  readonly variantLabel?: string;
}

export const IMAGE_MODEL_CONFIGS = {
  "gpt-image-1": {
    alias: "gpt-image-1",
    label: "GPT Image 1",
    variantLabel: "Standard",
  },
  "gpt-image-2": {
    alias: "gpt-image-2",
    label: "GPT Image 2",
  },
  "gpt-image-1.5": {
    alias: "gpt-image-1.5",
    label: "GPT Image 1.5",
  },
  "gpt-image-1-mini": {
    alias: "gpt-image-1-mini",
    label: "GPT Image 1 Mini",
    variantLabel: "Mini",
  },
  "fal-ai/flux-pro/v1.1": {
    alias: "flux-pro-1.1",
    label: "Flux Pro v1.1",
    variantLabel: "Standard",
  },
  "fal-ai/flux-pro/v1.1-ultra": {
    alias: "flux-pro-1.1-ultra",
    label: "Flux Pro v1.1 Ultra",
    variantLabel: "Ultra",
  },
  "fal-ai/qwen-image": {
    alias: "qwen-image",
    label: "Qwen Image",
  },
  "fal-ai/bytedance/seedream/v4/text-to-image": {
    alias: "seedream4",
    label: "Seedream 4",
  },
  "dola-seedream-5-0-pro-260628": {
    alias: "seedream5-pro",
    label: "Seedream 5 Pro",
    variantLabel: "Pro",
  },
  "seedream-5-0-lite-260128": {
    alias: "seedream5-lite",
    label: "Seedream 5 Lite",
    variantLabel: "Lite",
  },
  "fal-ai/nano-banana-2": {
    alias: "nano-banana-2",
    label: "Nano Banana 2",
  },
} as const satisfies Record<ImageModelId, ImageModelConfig>;

export type ImageModel = ImageModelId;

/** Reserved run environment key carrying the built-in image default alias. */
export const DEFAULT_IMAGE_MODEL_ENV = "OKOU_DEFAULT_IMAGE_MODEL";

/** All catalog models, in user-facing picker order. */
export const IMAGE_MODELS: readonly ImageModel[] = IMAGE_MODEL_IDS;

/**
 * Catalog models offered by the user-facing picker, in display order. Seedream 4
 * is deliberately absent: it stays generatable through its `seedream4` alias and
 * through defaults that already point at it, but it is superseded by Seedream 5
 * as a choice worth presenting.
 */
export const PUBLIC_IMAGE_MODELS = [
  "gpt-image-1",
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1-mini",
  "fal-ai/nano-banana-2",
  "fal-ai/flux-pro/v1.1",
  "fal-ai/flux-pro/v1.1-ultra",
  "dola-seedream-5-0-pro-260628",
  "seedream-5-0-lite-260128",
  "fal-ai/qwen-image",
] as const satisfies readonly ImageModel[];

interface ImageModelVariantGroup {
  /**
   * Family name for the row. It is stated rather than taken from the base
   * model's own label, which would repeat the variant name the segment control
   * already shows ("Seedream 5 Pro" next to a "Pro" chip).
   */
  readonly label: string;
  /** Base model first: it owns the row, the rest are reachable only from it. */
  readonly models: readonly [ImageModel, ...ImageModel[]];
}

/**
 * Sibling models that collapse into one picker row with a variant segment, so
 * one family costs one row instead of one row per variant.
 */
export const IMAGE_MODEL_VARIANT_GROUPS = [
  { label: "GPT Image 1", models: ["gpt-image-1", "gpt-image-1-mini"] },
  {
    label: "Flux Pro v1.1",
    models: ["fal-ai/flux-pro/v1.1", "fal-ai/flux-pro/v1.1-ultra"],
  },
  {
    label: "Seedream 5",
    models: ["dola-seedream-5-0-pro-260628", "seedream-5-0-lite-260128"],
  },
] as const satisfies readonly ImageModelVariantGroup[];

export const IMAGE_MODEL_ALIASES = {
  "gpt-image-2": "gpt-image-2",
  "gpt-image-1.5": "gpt-image-1.5",
  "gpt-image-1": "gpt-image-1",
  "gpt-image-1-mini": "gpt-image-1-mini",
  "flux-pro-1.1": "fal-ai/flux-pro/v1.1",
  "flux-pro-1.1-ultra": "fal-ai/flux-pro/v1.1-ultra",
  "qwen-image": "fal-ai/qwen-image",
  seedream4: "fal-ai/bytedance/seedream/v4/text-to-image",
  "seedream5-pro": "dola-seedream-5-0-pro-260628",
  "seedream5-lite": "seedream-5-0-lite-260128",
  "nano-banana-2": "fal-ai/nano-banana-2",
  "nano-banana2": "fal-ai/nano-banana-2",
} as const satisfies Readonly<Record<string, ImageModel>>;

/** Global fallback when no more specific image model default exists. */
export const DEFAULT_IMAGE_MODEL = "gpt-image-1" satisfies ImageModel;
