/**
 * Canonical IDs for prompt-based built-in image generation.
 *
 * Promptless transforms such as background removal and upscaling are not
 * selectable defaults and remain private to the image generation service.
 */
import { z } from "zod";

export const IMAGE_MODEL_IDS = [
  "gpt-image-2",
  "gpt-image-1",
  "fal-ai/flux-pro/v1.1",
  "fal-ai/flux-pro/v1.1-ultra",
  "fal-ai/qwen-image",
  "fal-ai/bytedance/seedream/v4/text-to-image",
  "dola-seedream-5-0-pro-260628",
  "seedream-5-0-lite-260128",
  "fal-ai/nano-banana-2",
] as const;

export type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];

const IMAGE_MODEL_ID_SET: ReadonlySet<string> = new Set(IMAGE_MODEL_IDS);

/** Returns whether a stored value still names a selectable image model. */
export function isImageModelId(
  model: string | null | undefined,
): model is ImageModelId {
  return typeof model === "string" && IMAGE_MODEL_ID_SET.has(model);
}

/** A canonical selectable image model id on the wire. */
export const imageModelIdSchema = z.enum(IMAGE_MODEL_IDS);
