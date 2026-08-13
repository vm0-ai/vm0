export const IMAGE_OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;

export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];

const FAL_IMAGE_OUTPUT_FORMATS: readonly ImageOutputFormat[] = ["png", "jpeg"];
const PNG_ONLY_OUTPUT_FORMATS: readonly ImageOutputFormat[] = ["png"];

// Output formats each built-in image model can emit, keyed by the model's
// canonical alias. Shared between the API, which rejects an unsupported
// combination, and the CLI, which rejects it locally so callers do not spend a
// round trip discovering that, for example, seedream4 cannot emit jpeg.
const IMAGE_MODEL_OUTPUT_FORMATS: Record<string, readonly ImageOutputFormat[]> =
  {
    "gpt-image-2": IMAGE_OUTPUT_FORMATS,
    "gpt-image-1.5": IMAGE_OUTPUT_FORMATS,
    "gpt-image-1": IMAGE_OUTPUT_FORMATS,
    "gpt-image-1-mini": IMAGE_OUTPUT_FORMATS,
    "flux-pro-1.1": FAL_IMAGE_OUTPUT_FORMATS,
    "flux-pro-1.1-ultra": FAL_IMAGE_OUTPUT_FORMATS,
    "qwen-image": FAL_IMAGE_OUTPUT_FORMATS,
    seedream4: PNG_ONLY_OUTPUT_FORMATS,
    "nano-banana-2": IMAGE_OUTPUT_FORMATS,
    birefnet: PNG_ONLY_OUTPUT_FORMATS,
    "clarity-upscaler": FAL_IMAGE_OUTPUT_FORMATS,
  };

/**
 * Output formats the given model alias can emit, or `undefined` when the alias
 * is not a canonical built-in image model. Callers that accept arbitrary user
 * input should treat `undefined` as "not mine to validate" and let the API
 * decide whether the model exists.
 */
export function imageModelOutputFormats(
  alias: string,
): readonly ImageOutputFormat[] | undefined {
  return IMAGE_MODEL_OUTPUT_FORMATS[alias];
}
