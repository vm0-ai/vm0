/**
 * Built-in credit price tiers for the image and video generation catalogs.
 *
 * Run models carry a hand-kept tier per model because a run's cost depends on
 * a token mix that no single number captures. A media generation is one
 * billable artifact, so the tier is derived instead: every model declares what
 * one reference generation costs in credits, and the tier follows from bands
 * that roughly double, the same spacing the run-model tiers already use.
 *
 * Reference credits come from the `usage_pricing` rows the generation services
 * bill against (1 USD = 1000 credits, provider markup included). Update a
 * number here whenever its pricing row moves.
 */
import type { ImageModelId } from "./image-models";
import type { Vm0ModelPriceTier } from "./model-price-tiers";
import type { VideoModelId } from "./video-models";

/** Inclusive upper bound of the `$`, `$$`, and `$$$` bands, in credits. */
type PriceTierBands = readonly [number, number, number];

function priceTierForCredits(
  credits: number,
  [economy, balanced, frontier]: PriceTierBands,
): Vm0ModelPriceTier {
  if (credits <= economy) {
    return "$";
  }
  if (credits <= balanced) {
    return "$$";
  }
  if (credits <= frontier) {
    return "$$$";
  }
  return "$$$$";
}

/**
 * Credits charged for the image every picker row describes: a single
 * 1024x1024 output at the default `medium` quality, generated from a prompt
 * alone. Per-megapixel models bill whole megapixels, and the two rules in play
 * disagree on what 1024x1024 is: fal's own billing units treat it as one
 * megapixel, while our megapixel counter divides by 1,000,000 and rounds up,
 * making it two.
 */
const IMAGE_MODEL_REFERENCE_CREDITS: Readonly<Record<ImageModelId, number>> =
  Object.freeze({
    // output_image.medium.standard
    "gpt-image-1": 50,
    "gpt-image-2": 64,
    // output_megapixel 48 x 2 megapixels
    "fal-ai/flux-pro/v1.1": 96,
    // output_image
    "fal-ai/flux-pro/v1.1-ultra": 72,
    // processed_megapixel.first, with no additional megapixel to bill
    "fal-ai/flux-2-pro": 36,
    // output_megapixel 24 x 2 megapixels
    "fal-ai/qwen-image": 48,
    // output_image.1k, the tier below 2,250,000 output pixels
    "alibaba/qwen-image-3/text-to-image": 48,
    // output_megapixel.balanced 18 x 1 fal billing unit
    "ideogram/v4": 18,
    // output_image
    "fal-ai/bytedance/seedream/v4/text-to-image": 36,
    // provider_cost_usd_micros: $0.045 of BytePlus cost at 1250 credits/USD
    "dola-seedream-5-0-pro-260628": 57,
    // provider_cost_usd_micros: $0.035 of BytePlus cost at 1250 credits/USD
    "seedream-5-0-lite-260128": 44,
    // output_image
    "fal-ai/nano-banana-2": 96,
    "google/nano-banana-2-lite": 50,
  } satisfies Record<ImageModelId, number>);

const IMAGE_PRICE_TIER_BANDS: PriceTierBands = [25, 60, 120];

export function getImageModelPriceTier(model: ImageModelId): Vm0ModelPriceTier {
  return priceTierForCredits(
    IMAGE_MODEL_REFERENCE_CREDITS[model],
    IMAGE_PRICE_TIER_BANDS,
  );
}

/**
 * Credits charged for the clip every picker row describes: 8 seconds at 16:9
 * and the model's own default resolution, with audio and without an input
 * video. Seedance models bill output tokens, which the service counts as
 * `width * height * seconds * 24 / 1024`; 16:9 at 720p is 1280x720, so an
 * 8-second clip is 172,800 tokens. The fal-hosted models bill by the second.
 */
const VIDEO_MODEL_REFERENCE_CREDITS: Readonly<Record<VideoModelId, number>> =
  Object.freeze({
    // output_video_tokens.480p_720p.no_video 13375/1M x 172,800 tokens
    "dreamina-seedance-2-5-260628": 2312,
    // 8750/1M x 172,800 tokens
    "dreamina-seedance-2-0-260128": 1512,
    // 7000/1M x 172,800 tokens
    "dreamina-seedance-2-0-fast-260128": 1210,
    // 4375/1M x 172,800 tokens
    "dreamina-seedance-2-0-mini-260615": 756,
    // output_video_tokens.audio 3000/1M x 172,800 tokens
    "seedance-1-5-pro-251215": 519,
    // output_video_seconds.audio 188 x 8 seconds
    "fal-ai/veo3.1/fast": 1504,
    // 4K only: output_video_seconds.audio.4k 525 x 8 seconds
    "fal-ai/kling-video/v3/4k/text-to-video": 4200,
    // Defaults to 2K: output_video_seconds.2k 163 x 8 seconds
    "MiniMax-H3": 1304,
  } satisfies Record<VideoModelId, number>);

const VIDEO_PRICE_TIER_BANDS: PriceTierBands = [800, 1600, 3200];

export function getVideoModelPriceTier(model: VideoModelId): Vm0ModelPriceTier {
  return priceTierForCredits(
    VIDEO_MODEL_REFERENCE_CREDITS[model],
    VIDEO_PRICE_TIER_BANDS,
  );
}
