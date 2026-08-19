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
}

export const IMAGE_MODEL_CONFIGS = {
  "gpt-image-2": {
    alias: "gpt-image-2",
    label: "GPT Image 2",
  },
  "fal-ai/flux-pro/v1.1": {
    alias: "flux-pro-1.1",
    label: "Flux Pro v1.1",
  },
  "fal-ai/flux-pro/v1.1-ultra": {
    alias: "flux-pro-1.1-ultra",
    label: "Flux Pro v1.1 Ultra",
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
  },
  "seedream-5-0-lite-260128": {
    alias: "seedream5-lite",
    label: "Seedream 5 Lite",
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

/** Every catalog model, ordered for the user-facing picker. */
export const PUBLIC_IMAGE_MODELS = [
  "gpt-image-2",
  "fal-ai/nano-banana-2",
  "fal-ai/flux-pro/v1.1",
  "fal-ai/flux-pro/v1.1-ultra",
  "dola-seedream-5-0-pro-260628",
  "seedream-5-0-lite-260128",
  "fal-ai/bytedance/seedream/v4/text-to-image",
  "fal-ai/qwen-image",
] as const satisfies readonly ImageModel[];

export const IMAGE_MODEL_ALIASES = {
  "gpt-image-2": "gpt-image-2",
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
export const DEFAULT_IMAGE_MODEL = "gpt-image-2" satisfies ImageModel;
