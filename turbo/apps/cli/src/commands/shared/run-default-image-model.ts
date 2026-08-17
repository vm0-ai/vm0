import { DEFAULT_IMAGE_MODEL_ENV } from "@okouai/core/image-model-catalog";

export function runDefaultImageModelFromEnvironment(): string | undefined {
  const model = process.env[DEFAULT_IMAGE_MODEL_ENV]?.trim();
  return model ? model : undefined;
}
