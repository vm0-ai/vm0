import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";

import { buildArtifactKey, buildFileUrl } from "../../lib/file-url";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import { putS3Object } from "../external/s3";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import {
  builtInGenerationUsageIdempotencyKey,
  type BuiltInGenerationUsageIdempotency,
} from "./built-in-generation-usage-idempotency";

const FAL_IMAGE_QUEUE_URL_PREFIX = "https://queue.fal.run";
export const IMAGE_IO_MODEL = "gpt-image-1";
const IMAGE_IO_MAX_PROMPT_LENGTH = 32_000;
const IMAGE_IO_MIN_PIXELS = 655_360;
const IMAGE_IO_MAX_PIXELS = 8_294_400;
const IMAGE_IO_MAX_EDGE = 3840;
const IMAGE_IO_EDGE_MULTIPLE = 16;
const IMAGE_IO_MAX_ASPECT_RATIO = 3;

const USAGE_KIND = "image";
const FAL_OUTPUT_IMAGE_CATEGORY = "output_image";
const FAL_OUTPUT_MEGAPIXEL_CATEGORY = "output_megapixel";
const FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES = [
  "output_image.low.standard",
  "output_image.low.large",
  "output_image.medium.standard",
  "output_image.medium.large",
  "output_image.high.standard",
  "output_image.high.large",
] as const;
const IMAGE_PRICING_CATEGORIES = [
  FAL_OUTPUT_IMAGE_CATEGORY,
  FAL_OUTPUT_MEGAPIXEL_CATEGORY,
  ...FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES,
] as const;

const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
const IMAGE_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const IMAGE_OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;
const IMAGE_MODERATIONS = ["auto", "low"] as const;
const IMAGE_SAFETY_TOLERANCES = ["1", "2", "3", "4", "5", "6"] as const;
const IMAGE_INPUT_FIDELITIES = ["low", "high"] as const;
const MAX_SOURCE_IMAGE_URLS = 10;
const STANDARD_GPT_IMAGE_SIZES = [
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
] as const;
const FAL_IMAGE_OUTPUT_FORMATS = ["png", "jpeg"] as const;
const FAL_IMAGE_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "3:2",
  "1:1",
  "2:3",
  "3:4",
  "9:16",
  "9:21",
] as const;

const IMAGE_MODEL_ALIASES = {
  "gpt-image-2": "gpt-image-2",
  "gpt-image-1.5": "gpt-image-1.5",
  "gpt-image-1": "gpt-image-1",
  "gpt-image-1-mini": "gpt-image-1-mini",
  "flux-pro-1.1": "fal-ai/flux-pro/v1.1",
  "flux-pro-1.1-ultra": "fal-ai/flux-pro/v1.1-ultra",
  "qwen-image": "fal-ai/qwen-image",
  seedream4: "fal-ai/bytedance/seedream/v4/text-to-image",
} as const;

const IMAGE_MODEL_CONFIGS = {
  "gpt-image-2": {
    alias: "gpt-image-2",
    endpointId: "openai/gpt-image-2",
    imageToImageEndpointId: "openai/gpt-image-2/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: undefined,
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES,
    billingMode: "quality_size_image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: true,
    supportsBackground: false,
    usesOpenAiByok: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: true,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  "gpt-image-1.5": {
    alias: "gpt-image-1.5",
    endpointId: "fal-ai/gpt-image-1.5",
    imageToImageEndpointId: "fal-ai/gpt-image-1.5/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "standard",
    sizeParameter: undefined,
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES,
    billingMode: "quality_size_image",
    supportsTransparentBackground: true,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: true,
    supportsBackground: true,
    usesOpenAiByok: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: true,
    supportsInputFidelity: true,
    supportsImagePromptStrength: false,
  },
  "gpt-image-1": {
    alias: "gpt-image-1",
    endpointId: "fal-ai/gpt-image-1/text-to-image",
    imageToImageEndpointId: "fal-ai/gpt-image-1/edit-image",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "standard",
    sizeParameter: undefined,
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES,
    billingMode: "quality_size_image",
    supportsTransparentBackground: true,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: true,
    supportsBackground: true,
    usesOpenAiByok: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: true,
    supportsImagePromptStrength: false,
  },
  "gpt-image-1-mini": {
    alias: "gpt-image-1-mini",
    endpointId: "fal-ai/gpt-image-1-mini",
    imageToImageEndpointId: "fal-ai/gpt-image-1-mini/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "standard",
    sizeParameter: undefined,
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES,
    billingMode: "quality_size_image",
    supportsTransparentBackground: true,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: true,
    supportsBackground: true,
    usesOpenAiByok: false,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  "fal-ai/flux-pro/v1.1": {
    alias: "flux-pro-1.1",
    endpointId: "fal-ai/flux-pro/v1.1",
    imageToImageEndpointId: "fal-ai/flux-pro/v1.1/redux",
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_MEGAPIXEL_CATEGORY],
    billingMode: "megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: true,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: true,
  },
  "fal-ai/flux-pro/v1.1-ultra": {
    alias: "flux-pro-1.1-ultra",
    endpointId: "fal-ai/flux-pro/v1.1-ultra",
    imageToImageEndpointId: "fal-ai/flux-pro/v1.1-ultra/redux",
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "aspect_ratio",
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: true,
  },
  "fal-ai/qwen-image": {
    alias: "qwen-image",
    endpointId: "fal-ai/qwen-image",
    imageToImageEndpointId: "fal-ai/qwen-image-2/edit",
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_MEGAPIXEL_CATEGORY],
    billingMode: "megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  "fal-ai/bytedance/seedream/v4/text-to-image": {
    alias: "seedream4",
    endpointId: "fal-ai/bytedance/seedream/v4/text-to-image",
    imageToImageEndpointId: "fal-ai/bytedance/seedream/v4/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: ["png"],
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
} as const;

const IMAGE_MODELS = Object.keys(IMAGE_MODEL_CONFIGS) as ImageModel[];
const L = logger("ZeroImageIoGenerate");

type ImageQuality = (typeof IMAGE_QUALITIES)[number];
type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];
type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
type ImageModeration = (typeof IMAGE_MODERATIONS)[number];
type ImageSafetyTolerance = (typeof IMAGE_SAFETY_TOLERANCES)[number];
type ImageInputFidelity = (typeof IMAGE_INPUT_FIDELITIES)[number];
type ImagePricingCategory = (typeof IMAGE_PRICING_CATEGORIES)[number];
export type ImageModel = keyof typeof IMAGE_MODEL_CONFIGS;
export type ImageProvider = "fal";
type ImageModelConfig = (typeof IMAGE_MODEL_CONFIGS)[ImageModel];

type ErrorStatus = 400 | 402 | 500 | 502 | 503;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

type ErrorResponse = {
  readonly status: ErrorStatus;
  readonly body: ErrorBody;
};

interface ImagePricingRow {
  readonly provider: ImageModel;
  readonly category: ImagePricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

export type ImagePricing = ReadonlyMap<string, ImagePricingRow>;

interface ImageOutputOptions {
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression: number | undefined;
}

export interface ImageOptions {
  readonly model: ImageModel;
  readonly provider: ImageProvider;
  readonly prompt: string;
  readonly size: string;
  readonly quality: ImageQuality;
  readonly background: ImageBackground;
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression: number | undefined;
  readonly moderation: ImageModeration;
  readonly seed: number | undefined;
  readonly safetyTolerance: ImageSafetyTolerance;
  readonly enhancePrompt: boolean;
  readonly sourceImageUrls: readonly string[];
  readonly maskImageUrl: string | undefined;
  readonly inputFidelity: ImageInputFidelity | undefined;
  readonly imagePromptStrength: number | undefined;
}

interface ParsedImageGeneration {
  readonly model: ImageModel;
  readonly provider: ImageProvider;
  readonly imageBytes: Buffer;
  readonly revisedPrompt: string | undefined;
  readonly imageSize: string;
  readonly quality: string;
  readonly background: string;
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression: number | undefined;
  readonly moderation: ImageModeration;
  readonly safetyTolerance: ImageSafetyTolerance | undefined;
  readonly billing: readonly ImageBillingEntry[];
  readonly sourceUrl: string | undefined;
  readonly seed: number | undefined;
  readonly sourceImageUrls: readonly string[];
  readonly maskImageUrl: string | undefined;
  readonly inputFidelity: ImageInputFidelity | undefined;
  readonly imagePromptStrength: number | undefined;
}

interface RecordedImage {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly creditsCharged: number;
  readonly model: string;
  readonly provider: ImageProvider;
  readonly imageSize: string;
  readonly quality: string;
  readonly background: string;
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression: number | undefined;
  readonly moderation: ImageModeration;
  readonly safetyTolerance: ImageSafetyTolerance | undefined;
  readonly revisedPrompt: string | undefined;
  readonly billingCategory: string | undefined;
  readonly billingQuantity: number | undefined;
  readonly sourceUrl: string | undefined;
  readonly seed: number | undefined;
  readonly sourceImageUrls: readonly string[];
  readonly maskImageUrl: string | undefined;
  readonly inputFidelity: ImageInputFidelity | undefined;
  readonly imagePromptStrength: number | undefined;
}

interface ImageBillingEntry {
  readonly category: ImagePricingCategory;
  readonly quantity: number;
}

interface FalImageFile {
  readonly url: string;
  readonly contentType: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
}

interface FalImageResult {
  readonly image: FalImageFile;
  readonly revisedPrompt: string | undefined;
  readonly seed: number | undefined;
}

interface FalImageQueueHandle {
  readonly requestId: string | undefined;
  readonly statusUrl: string;
  readonly responseUrl: string;
}

interface CreditCheckRow extends Record<string, unknown> {
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string, code = "BAD_REQUEST") {
  return { status: 400 as const, body: errorBody(message, code) };
}

function badGateway(message: string, code: string) {
  return { status: 502 as const, body: errorBody(message, code) };
}

export function serviceUnavailable(message: string, code: string) {
  return { status: 503 as const, body: errorBody(message, code) };
}

export function insufficientCredits() {
  return {
    status: 402 as const,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  body: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readOptionalInteger(
  body: Record<string, unknown>,
  key: string,
): number | ErrorResponse | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed)) {
    return badRequest(`${key} must be an integer`);
  }

  return parsed;
}

function readOptionalNumberFromKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
): number | ErrorResponse | undefined {
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim().length > 0
          ? Number(value.trim())
          : Number.NaN;
    if (!Number.isFinite(parsed)) {
      return badRequest(`${key} must be a number`);
    }
    return parsed;
  }
  return undefined;
}

function readOptionalStringFromKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
): string | ErrorResponse | undefined {
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      return badRequest(`${key} must be a non-empty string`);
    }
    return value.trim();
  }
  return undefined;
}

function includesString<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return values.some((candidate) => {
    return candidate === value;
  });
}

function hasString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function normalizeImageModel(value: string): ImageModel | null {
  if (value in IMAGE_MODEL_CONFIGS) {
    return value as ImageModel;
  }
  if (value in IMAGE_MODEL_ALIASES) {
    return IMAGE_MODEL_ALIASES[value as keyof typeof IMAGE_MODEL_ALIASES];
  }
  return null;
}

function imageModelList(): string {
  return Object.keys(IMAGE_MODEL_ALIASES).join(", ");
}

export function imagePricingKey(
  model: ImageModel,
  category: ImagePricingCategory,
): string {
  return `${model}:${category}`;
}

export function getMissingImagePricing(
  pricing: ImagePricing,
  model: ImageModel,
): readonly ImagePricingCategory[] {
  return IMAGE_MODEL_CONFIGS[model].pricingCategories.filter((category) => {
    return !pricing.has(imagePricingKey(model, category));
  });
}

function parseSize(size: string): {
  readonly width: number;
  readonly height: number;
} | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(
  model: ImageModel,
  size: string,
): ErrorResponse | null {
  if (size === "auto") {
    return null;
  }

  const parsed = parseSize(size);
  if (!parsed) {
    return badRequest(`Unsupported image size: ${size}`);
  }

  const { width, height } = parsed;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  const modelConfig = IMAGE_MODEL_CONFIGS[model];

  if (
    modelConfig.sizeMode === "standard" &&
    !hasString(STANDARD_GPT_IMAGE_SIZES, size)
  ) {
    return badRequest(
      `Unsupported image size for ${modelConfig.alias}: ${size}. Use auto, 1024x1024, 1536x1024, or 1024x1536`,
    );
  }

  if (longEdge > IMAGE_IO_MAX_EDGE) {
    return badRequest(
      `Unsupported image size: ${size}; max edge is ${IMAGE_IO_MAX_EDGE}px`,
    );
  }
  if (
    width % IMAGE_IO_EDGE_MULTIPLE !== 0 ||
    height % IMAGE_IO_EDGE_MULTIPLE !== 0
  ) {
    return badRequest(
      `Unsupported image size: ${size}; both edges must be multiples of ${IMAGE_IO_EDGE_MULTIPLE}px`,
    );
  }
  if (longEdge / shortEdge > IMAGE_IO_MAX_ASPECT_RATIO) {
    return badRequest(
      `Unsupported image size: ${size}; aspect ratio must be at most ${IMAGE_IO_MAX_ASPECT_RATIO}:1`,
    );
  }
  if (pixels < IMAGE_IO_MIN_PIXELS || pixels > IMAGE_IO_MAX_PIXELS) {
    return badRequest(
      `Unsupported image size: ${size}; total pixels must be between ${IMAGE_IO_MIN_PIXELS} and ${IMAGE_IO_MAX_PIXELS}`,
    );
  }

  return null;
}

function readOptionalSafeInteger(
  body: Record<string, unknown>,
  key: string,
): number | ErrorResponse | undefined {
  const value = readOptionalInteger(body, key);
  if (typeof value === "object") {
    return value;
  }
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    return badRequest(`${key} must be a non-negative safe integer`);
  }
  return value;
}

function readBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function parsePrompt(body: Record<string, unknown>): string | ErrorResponse {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    return badRequest("prompt is required");
  }
  if (prompt.length > IMAGE_IO_MAX_PROMPT_LENGTH) {
    return badRequest(
      `prompt exceeds ${IMAGE_IO_MAX_PROMPT_LENGTH} characters`,
    );
  }

  return prompt;
}

function parseImageModel(
  body: Record<string, unknown>,
): ImageModel | ErrorResponse {
  const rawModel = readString(body, "model", IMAGE_IO_MODEL);
  const model = normalizeImageModel(rawModel);
  if (!model) {
    return badRequest(
      `Unsupported image model: ${rawModel}. Available models: ${imageModelList()}`,
    );
  }

  return model;
}

function parseImageQuality(
  body: Record<string, unknown>,
): ImageQuality | ErrorResponse {
  const quality = readString(body, "quality", "medium");
  if (!includesString(IMAGE_QUALITIES, quality)) {
    return badRequest(`Unsupported image quality: ${quality}`);
  }

  return quality;
}

function parseImageBackground(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageBackground | ErrorResponse {
  const background = readString(body, "background", "auto");
  if (!includesString(IMAGE_BACKGROUNDS, background)) {
    return badRequest(`Unsupported image background: ${background}`);
  }
  if (
    background === "transparent" &&
    !modelConfig.supportsTransparentBackground
  ) {
    return badRequest(
      `${modelConfig.alias} does not support transparent backgrounds`,
    );
  }

  return background;
}

function parseImageOutputOptions(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  background: ImageBackground,
): ImageOutputOptions | ErrorResponse {
  const outputFormat = readString(body, "outputFormat", "png");
  if (!includesString(IMAGE_OUTPUT_FORMATS, outputFormat)) {
    return badRequest(`Unsupported image output format: ${outputFormat}`);
  }
  if (!hasString(modelConfig.outputFormats, outputFormat)) {
    return badRequest(
      `Unsupported image output format for ${modelConfig.alias}: ${outputFormat}`,
    );
  }

  const outputCompression = readOptionalInteger(body, "outputCompression");
  if (typeof outputCompression === "object") {
    return outputCompression;
  }
  if (
    outputCompression !== undefined &&
    (outputCompression < 0 || outputCompression > 100)
  ) {
    return badRequest("outputCompression must be between 0 and 100");
  }
  if (outputCompression !== undefined && outputFormat === "png") {
    return badRequest(
      "outputCompression is only supported for jpeg or webp output",
    );
  }
  if (
    outputCompression !== undefined &&
    !modelConfig.supportsOutputCompression
  ) {
    return badRequest(
      `outputCompression is not supported for ${modelConfig.alias}`,
    );
  }
  if (background === "transparent" && outputFormat === "jpeg") {
    return badRequest("transparent backgrounds require png or webp output");
  }

  return { outputFormat, outputCompression };
}

function parseImageModeration(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageModeration | ErrorResponse {
  const moderation = readString(body, "moderation", "auto");
  if (!includesString(IMAGE_MODERATIONS, moderation)) {
    return badRequest(`Unsupported image moderation: ${moderation}`);
  }
  if (moderation !== "auto" && !modelConfig.supportsModeration) {
    return badRequest(`moderation is not supported for ${modelConfig.alias}`);
  }

  return moderation;
}

function parseImageSeed(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): number | ErrorResponse | undefined {
  const seed = readOptionalSafeInteger(body, "seed");
  if (typeof seed === "object") {
    return seed;
  }
  if (seed !== undefined && !modelConfig.supportsSeed) {
    return badRequest(`seed is not supported for ${modelConfig.alias}`);
  }

  return seed;
}

function parseSafetyTolerance(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageSafetyTolerance | ErrorResponse {
  const safetyTolerance = readString(body, "safetyTolerance", "4");
  if (!includesString(IMAGE_SAFETY_TOLERANCES, safetyTolerance)) {
    return badRequest(`Unsupported safety tolerance: ${safetyTolerance}`);
  }
  if (safetyTolerance !== "4" && !modelConfig.supportsSafetyTolerance) {
    return badRequest(
      `safetyTolerance is not supported for ${modelConfig.alias}`,
    );
  }

  return safetyTolerance;
}

function parseEnhancePrompt(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): boolean | ErrorResponse {
  const enhancePrompt = readBoolean(
    body,
    "enhancePrompt",
    readBoolean(body, "enhance_prompt", false),
  );
  if (enhancePrompt && !modelConfig.supportsEnhancePrompt) {
    return badRequest(
      `enhancePrompt is not supported for ${modelConfig.alias}`,
    );
  }

  return enhancePrompt;
}

function appendSourceImageUrls(
  target: string[],
  value: unknown,
  key: string,
): ErrorResponse | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return badRequest(`${key} must contain non-empty strings`);
    }
    target.push(item.trim());
  }
  return null;
}

function parseSourceImageUrls(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): readonly string[] | ErrorResponse {
  const sourceImageUrls: string[] = [];
  for (const key of [
    "imageUrl",
    "image_url",
    "imageUrls",
    "image_urls",
    "sourceImageUrls",
  ]) {
    const error = appendSourceImageUrls(sourceImageUrls, body[key], key);
    if (error) {
      return error;
    }
  }

  if (sourceImageUrls.length === 0) {
    return sourceImageUrls;
  }
  if (sourceImageUrls.length > MAX_SOURCE_IMAGE_URLS) {
    return badRequest(
      `imageUrls supports at most ${MAX_SOURCE_IMAGE_URLS} images`,
    );
  }
  if (
    modelConfig.sourceImageInput === "image_url" &&
    sourceImageUrls.length > 1
  ) {
    return badRequest(`${modelConfig.alias} accepts one source image`);
  }

  return sourceImageUrls;
}

function parseMaskImageUrl(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  hasSourceImages: boolean,
): string | ErrorResponse | undefined {
  const maskImageUrl = readOptionalStringFromKeys(body, [
    "maskImageUrl",
    "mask_image_url",
  ]);
  if (typeof maskImageUrl === "object") {
    return maskImageUrl;
  }
  if (!maskImageUrl) {
    return undefined;
  }
  if (!hasSourceImages) {
    return badRequest("maskImageUrl requires imageUrl");
  }
  if (!modelConfig.supportsMaskImage) {
    return badRequest(`maskImageUrl is not supported for ${modelConfig.alias}`);
  }
  return maskImageUrl;
}

function parseInputFidelity(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  hasSourceImages: boolean,
): ImageInputFidelity | ErrorResponse | undefined {
  const inputFidelity = readOptionalStringFromKeys(body, [
    "inputFidelity",
    "input_fidelity",
  ]);
  if (typeof inputFidelity === "object") {
    return inputFidelity;
  }
  if (!inputFidelity) {
    return undefined;
  }
  if (!includesString(IMAGE_INPUT_FIDELITIES, inputFidelity)) {
    return badRequest(`Unsupported input fidelity: ${inputFidelity}`);
  }
  if (!hasSourceImages) {
    return badRequest("inputFidelity requires imageUrl");
  }
  if (!modelConfig.supportsInputFidelity) {
    return badRequest(
      `inputFidelity is not supported for ${modelConfig.alias}`,
    );
  }
  return inputFidelity;
}

function parseImagePromptStrength(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  hasSourceImages: boolean,
): number | ErrorResponse | undefined {
  const imagePromptStrength = readOptionalNumberFromKeys(body, [
    "imagePromptStrength",
    "image_prompt_strength",
  ]);
  if (typeof imagePromptStrength === "object") {
    return imagePromptStrength;
  }
  if (imagePromptStrength !== undefined) {
    if (imagePromptStrength < 0 || imagePromptStrength > 1) {
      return badRequest("imagePromptStrength must be between 0 and 1");
    }
    if (!hasSourceImages) {
      return badRequest("imagePromptStrength requires imageUrl");
    }
    if (!modelConfig.supportsImagePromptStrength) {
      return badRequest(
        `imagePromptStrength is not supported for ${modelConfig.alias}`,
      );
    }
    return imagePromptStrength;
  }
  return undefined;
}

export function parseImageOptions(body: unknown): ImageOptions | ErrorResponse {
  if (!isRecord(body)) {
    return badRequest("Invalid JSON body");
  }

  const prompt = parsePrompt(body);
  if (typeof prompt === "object") {
    return prompt;
  }

  const model = parseImageModel(body);
  if (typeof model === "object") {
    return model;
  }
  const modelConfig = IMAGE_MODEL_CONFIGS[model];

  const sourceImageUrls = parseSourceImageUrls(body, modelConfig);
  if (typeof sourceImageUrls === "object" && "status" in sourceImageUrls) {
    return sourceImageUrls;
  }
  const hasSourceImages = sourceImageUrls.length > 0;

  const size = readString(body, "size", hasSourceImages ? "auto" : "1024x1024");
  const sizeError = validateImageSize(model, size);
  if (sizeError) {
    return sizeError;
  }

  const quality = parseImageQuality(body);
  if (typeof quality === "object") {
    return quality;
  }

  const background = parseImageBackground(body, modelConfig);
  if (typeof background === "object") {
    return background;
  }

  const outputOptions = parseImageOutputOptions(body, modelConfig, background);
  if (typeof outputOptions === "object" && "status" in outputOptions) {
    return outputOptions;
  }

  const moderation = parseImageModeration(body, modelConfig);
  if (typeof moderation === "object") {
    return moderation;
  }

  const seed = parseImageSeed(body, modelConfig);
  if (typeof seed === "object") {
    return seed;
  }

  const safetyTolerance = parseSafetyTolerance(body, modelConfig);
  if (typeof safetyTolerance === "object") {
    return safetyTolerance;
  }

  const enhancePrompt = parseEnhancePrompt(body, modelConfig);
  if (typeof enhancePrompt === "object") {
    return enhancePrompt;
  }

  const maskImageUrl = parseMaskImageUrl(body, modelConfig, hasSourceImages);
  if (typeof maskImageUrl === "object") {
    return maskImageUrl;
  }

  const inputFidelity = parseInputFidelity(body, modelConfig, hasSourceImages);
  if (typeof inputFidelity === "object") {
    return inputFidelity;
  }

  const imagePromptStrength = parseImagePromptStrength(
    body,
    modelConfig,
    hasSourceImages,
  );
  if (typeof imagePromptStrength === "object") {
    return imagePromptStrength;
  }

  return {
    model,
    provider: modelConfig.provider,
    prompt,
    size,
    quality,
    background,
    outputFormat: outputOptions.outputFormat,
    outputCompression: outputOptions.outputCompression,
    moderation,
    seed,
    safetyTolerance,
    enhancePrompt,
    sourceImageUrls,
    maskImageUrl,
    inputFidelity,
    imagePromptStrength,
  };
}

function mapPricingRows(
  rows: readonly {
    readonly provider: string;
    readonly category: string;
    readonly unitPrice: number;
    readonly unitSize: number;
  }[],
): ImagePricing {
  const pricing = new Map<string, ImagePricingRow>();
  for (const row of rows) {
    const model = normalizeImageModel(row.provider);
    if (model && includesString(IMAGE_PRICING_CATEGORIES, row.category)) {
      pricing.set(imagePricingKey(model, row.category), {
        provider: model,
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }
  return pricing;
}

export const imagePricing$: Computed<Promise<ImagePricing>> = computed(
  async (get): Promise<ImagePricing> => {
    const db = get(db$);
    const rows = await db
      .select({
        provider: usagePricing.provider,
        category: usagePricing.category,
        unitPrice: usagePricing.unitPrice,
        unitSize: usagePricing.unitSize,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, USAGE_KIND),
          inArray(usagePricing.provider, [...IMAGE_MODELS]),
          inArray(usagePricing.category, [...IMAGE_PRICING_CATEGORIES]),
        ),
      );

    return mapPricingRows(rows);
  },
);

export const checkImageCredits$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const { rows } = await writeDb.execute<CreditCheckRow>(sql`
      WITH org AS (
        SELECT credits FROM org_metadata
        WHERE org_id = ${args.orgId}
        LIMIT 1
      ),
      expired AS (
        SELECT COALESCE(SUM(remaining), 0)::bigint AS total
        FROM credit_expires_record
        WHERE org_id = ${args.orgId}
          AND expires_at <= now()
          AND remaining > 0
      )
      SELECT
        (SELECT credits FROM org) AS credits,
        (SELECT total FROM expired) AS unsettled_expired
    `);
    signal.throwIfAborted();

    const row = rows[0];
    if (!row || row.credits === null) {
      return false;
    }

    const credits = Number(row.credits);
    const unsettledExpired = Number(row.unsettled_expired ?? 0);
    return credits - unsettledExpired > 0;
  },
);

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function contentTypeForFormat(format: ImageOutputFormat): string {
  if (format === "webp") {
    return "image/webp";
  }
  if (format === "jpeg") {
    return "image/jpeg";
  }
  return "image/png";
}

function normalizeImageContentType(value: string | null | undefined) {
  const contentType = value?.split(";")[0]?.trim().toLowerCase();
  if (
    contentType === "image/png" ||
    contentType === "image/webp" ||
    contentType === "image/jpeg"
  ) {
    return contentType;
  }
  return null;
}

function formatForContentType(contentType: string): ImageOutputFormat {
  if (contentType === "image/webp") {
    return "webp";
  }
  if (contentType === "image/jpeg") {
    return "jpeg";
  }
  return "png";
}

function extensionForFormat(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function estimateImageCredits(
  model: ImageModel,
  billing: readonly ImageBillingEntry[],
  pricing: ImagePricing,
): number {
  return billing.reduce((total, row) => {
    const { category, quantity } = row;
    if (quantity <= 0) {
      return total;
    }
    const pricingRow = pricing.get(imagePricingKey(model, category));
    if (!pricingRow) {
      return total;
    }
    return (
      total + Math.ceil((quantity * pricingRow.unitPrice) / pricingRow.unitSize)
    );
  }, 0);
}

function falHeaders(falKey: string): Record<string, string> {
  return {
    Authorization: `Key ${falKey}`,
    "Content-Type": "application/json",
  };
}

function parseFalQueueHandle(value: unknown): FalImageQueueHandle | null {
  if (!isRecord(value)) {
    return null;
  }
  const statusUrl =
    typeof value.status_url === "string" ? value.status_url : undefined;
  const responseUrl =
    typeof value.response_url === "string" ? value.response_url : undefined;
  if (!statusUrl || !responseUrl) {
    return null;
  }
  return {
    requestId:
      typeof value.request_id === "string" ? value.request_id : undefined,
    statusUrl,
    responseUrl,
  };
}

function nearestFalAspectRatio(width: number, height: number): string {
  const requestedRatio = width / height;
  let bestRatio: (typeof FAL_IMAGE_ASPECT_RATIOS)[number] =
    FAL_IMAGE_ASPECT_RATIOS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of FAL_IMAGE_ASPECT_RATIOS) {
    const [ratioWidth, ratioHeight] = ratio.split(":").map(Number) as [
      number,
      number,
    ];
    const distance = Math.abs(requestedRatio - ratioWidth / ratioHeight);
    if (distance < bestDistance) {
      bestRatio = ratio;
      bestDistance = distance;
    }
  }
  return bestRatio;
}

function falImageSize(options: ImageOptions) {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  if (options.size === "auto") {
    if (modelConfig.sizeMode === "standard") {
      return "1024x1024";
    }
    return "landscape_4_3";
  }
  const parsed = parseSize(options.size);
  if (!parsed) {
    return "landscape_4_3";
  }
  if (modelConfig.sizeMode === "standard") {
    return options.size;
  }
  return parsed;
}

function falAspectRatio(options: ImageOptions): string {
  if (options.size === "auto") {
    return "16:9";
  }
  const parsed = parseSize(options.size);
  if (!parsed) {
    return "16:9";
  }
  return nearestFalAspectRatio(parsed.width, parsed.height);
}

function falImageInput(options: ImageOptions): Record<string, unknown> {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  return {
    prompt: options.prompt,
    ...(modelConfig.sizeParameter === "aspect_ratio"
      ? { aspect_ratio: falAspectRatio(options) }
      : { image_size: falImageSize(options) }),
    num_images: 1,
    ...(hasString(modelConfig.outputFormats, options.outputFormat) &&
    modelConfig.alias !== "seedream4"
      ? { output_format: options.outputFormat }
      : {}),
    ...(modelConfig.supportsQuality ? { quality: options.quality } : {}),
    ...(modelConfig.supportsBackground
      ? { background: options.background }
      : {}),
    ...(modelConfig.usesOpenAiByok
      ? { openai_api_key: env("OPENAI_API_KEY") }
      : {}),
    ...(modelConfig.supportsSeed && options.seed !== undefined
      ? { seed: options.seed }
      : {}),
    ...(modelConfig.supportsSafetyTolerance
      ? { safety_tolerance: options.safetyTolerance }
      : {}),
    ...(modelConfig.supportsEnhancePrompt
      ? { enhance_prompt: options.enhancePrompt }
      : {}),
    ...(options.sourceImageUrls.length > 0
      ? modelConfig.sourceImageInput === "image_url"
        ? { image_url: options.sourceImageUrls[0] }
        : { image_urls: options.sourceImageUrls }
      : {}),
    ...(modelConfig.supportsMaskImage && options.maskImageUrl
      ? { mask_image_url: options.maskImageUrl }
      : {}),
    ...(modelConfig.supportsInputFidelity && options.inputFidelity
      ? { input_fidelity: options.inputFidelity }
      : {}),
    ...(modelConfig.supportsImagePromptStrength &&
    options.imagePromptStrength !== undefined
      ? { image_prompt_strength: options.imagePromptStrength }
      : {}),
  };
}

function falImageEndpointId(options: ImageOptions): string {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  return options.sourceImageUrls.length > 0
    ? modelConfig.imageToImageEndpointId
    : modelConfig.endpointId;
}

async function readFalErrorBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const body = await response.text();
  signal.throwIfAborted();
  return body.slice(0, 4000);
}

export async function submitFalImageQueueGeneration(
  options: ImageOptions,
  falKey: string,
  webhookUrl: string,
  signal: AbortSignal,
): Promise<FalImageQueueHandle | ErrorResponse> {
  const endpointId = falImageEndpointId(options);
  const queueUrl = new URL(`${FAL_IMAGE_QUEUE_URL_PREFIX}/${endpointId}`);
  queueUrl.searchParams.set("fal_webhook", webhookUrl);
  const response = await fetch(queueUrl, {
    method: "POST",
    headers: falHeaders(falKey),
    body: JSON.stringify(falImageInput(options)),
    signal,
  });

  if (!response.ok) {
    const errorBody = await readFalErrorBody(response, signal);
    L.error("Fal image queue request failed", {
      endpointId,
      model: options.model,
      status: response.status,
      body: errorBody,
    });
    return badGateway("Image generation failed", "FAL_IMAGE_REQUEST_FAILED");
  }

  const body: unknown = await response.json();
  const handle = parseFalQueueHandle(body);
  if (!handle) {
    return badGateway("Fal returned no queue handle", "NO_QUEUE_HANDLE");
  }
  return handle;
}

function parseFalImageFile(value: unknown): FalImageFile | null {
  if (!isRecord(value) || typeof value.url !== "string") {
    return null;
  }
  return {
    url: value.url,
    contentType:
      typeof value.content_type === "string" ? value.content_type : undefined,
    width: readNumber(value.width),
    height: readNumber(value.height),
  };
}

function readFalSeed(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

export function parseFalImageResult(
  value: unknown,
): FalImageResult | ErrorResponse {
  if (!isRecord(value) || !Array.isArray(value.images)) {
    return badGateway("Model returned no image data", "NO_IMAGE_RETURNED");
  }

  const image = parseFalImageFile(value.images[0]);
  if (!image) {
    return badGateway("Model returned no image data", "NO_IMAGE_RETURNED");
  }

  return {
    image,
    revisedPrompt:
      typeof value.prompt === "string"
        ? value.prompt
        : typeof value.description === "string"
          ? value.description
          : undefined,
    seed: readFalSeed(value.seed),
  };
}

function megapixelsForImage(
  image: FalImageFile,
  options: ImageOptions,
): number {
  if (image.width && image.height) {
    return Math.max(1, Math.ceil((image.width * image.height) / 1_000_000));
  }
  const parsed = parseSize(options.size);
  if (!parsed) {
    return 1;
  }
  return Math.max(1, Math.ceil((parsed.width * parsed.height) / 1_000_000));
}

function falBillingEntries(
  image: FalImageFile,
  options: ImageOptions,
): readonly ImageBillingEntry[] {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  if (modelConfig.billingMode === "megapixel") {
    return [
      {
        category: FAL_OUTPUT_MEGAPIXEL_CATEGORY,
        quantity: megapixelsForImage(image, options),
      },
    ];
  }
  if (modelConfig.billingMode === "quality_size_image") {
    return [
      { category: falQualitySizeImageCategory(image, options), quantity: 1 },
    ];
  }
  return [{ category: FAL_OUTPUT_IMAGE_CATEGORY, quantity: 1 }];
}

function falQualitySizeImageCategory(
  image: FalImageFile,
  options: ImageOptions,
): ImagePricingCategory {
  const quality =
    options.quality === "high" || options.quality === "low"
      ? options.quality
      : "medium";
  const imageSize =
    image.width && image.height
      ? `${image.width}x${image.height}`
      : options.size;
  const sizeTier =
    imageSize === "auto" || imageSize === "1024x1024" ? "standard" : "large";
  return `output_image.${quality}.${sizeTier}` as ImagePricingCategory;
}

export async function downloadFalImage(
  result: FalImageResult,
  options: ImageOptions,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | ErrorResponse> {
  const response = await fetch(result.image.url, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download generated image",
      "IMAGE_DOWNLOAD_FAILED",
    );
  }

  const imageBytes = Buffer.from(await response.arrayBuffer());
  if (imageBytes.byteLength === 0) {
    return badGateway("Model returned empty image", "NO_IMAGE_RETURNED");
  }

  const contentType =
    normalizeImageContentType(result.image.contentType) ??
    normalizeImageContentType(response.headers.get("content-type")) ??
    contentTypeForFormat(options.outputFormat);
  const outputFormat = formatForContentType(contentType);
  const imageSize =
    result.image.width && result.image.height
      ? `${result.image.width}x${result.image.height}`
      : options.size;
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];

  return {
    model: options.model,
    provider: "fal",
    imageBytes,
    revisedPrompt: result.revisedPrompt,
    imageSize,
    quality: modelConfig.supportsQuality ? options.quality : "model-default",
    background: modelConfig.supportsBackground ? options.background : "auto",
    outputFormat,
    outputCompression: undefined,
    moderation: options.moderation,
    safetyTolerance: modelConfig.supportsSafetyTolerance
      ? options.safetyTolerance
      : undefined,
    billing: falBillingEntries(result.image, options),
    sourceUrl: result.image.url,
    seed: result.seed ?? options.seed,
    sourceImageUrls: options.sourceImageUrls,
    maskImageUrl: options.maskImageUrl,
    inputFidelity: options.inputFidelity,
    imagePromptStrength: options.imagePromptStrength,
  };
}

export const recordGeneratedImage$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly pricing: ImagePricing;
      readonly generation: ParsedImageGeneration;
      readonly recordArtifact?: boolean;
      readonly usageIdempotency: BuiltInGenerationUsageIdempotency;
    },
    signal: AbortSignal,
  ): Promise<RecordedImage> => {
    const writeDb = set(writeDb$);
    const fileId = randomUUID();
    const filename = `image-${fileId.slice(0, 8)}.${extensionForFormat(
      params.generation.outputFormat,
    )}`;
    const s3Key = buildArtifactKey(params.userId, fileId, filename);
    const contentType = contentTypeForFormat(params.generation.outputFormat);
    await get(
      putS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        s3Key,
        params.generation.imageBytes,
        contentType,
      ),
    );
    signal.throwIfAborted();

    const url = buildFileUrl(params.userId, fileId, filename);
    if (params.recordArtifact !== false) {
      await set(
        recordWebUploadedFile$,
        {
          runId: params.runId,
          externalId: fileId,
          userId: params.userId,
          orgId: params.orgId,
          filename,
          contentType,
          sizeBytes: params.generation.imageBytes.byteLength,
          url,
          s3Key,
          metadata: {
            generatedBy: "zero-official-image",
            model: params.generation.model,
            provider: params.generation.provider,
            imageSize: params.generation.imageSize,
            quality: params.generation.quality,
            background: params.generation.background,
            outputFormat: params.generation.outputFormat,
            ...(params.generation.outputCompression !== undefined
              ? { outputCompression: params.generation.outputCompression }
              : {}),
            moderation: params.generation.moderation,
            safetyTolerance: params.generation.safetyTolerance,
            sourceUrl: params.generation.sourceUrl,
            seed: params.generation.seed,
            sourceImageUrls: params.generation.sourceImageUrls,
            maskImageUrl: params.generation.maskImageUrl,
            inputFidelity: params.generation.inputFidelity,
            imagePromptStrength: params.generation.imagePromptStrength,
          },
        },
        signal,
      );
      signal.throwIfAborted();
    }

    const usageRows = params.generation.billing.filter((row) => {
      return row.quantity > 0;
    });

    await writeDb
      .insert(usageEvent)
      .values(
        usageRows.map((row) => {
          return {
            runId: params.runId ?? null,
            idempotencyKey: builtInGenerationUsageIdempotencyKey({
              ...params.usageIdempotency,
              category: row.category,
            }),
            orgId: params.orgId,
            userId: params.userId,
            kind: USAGE_KIND,
            provider: params.generation.model,
            category: row.category,
            quantity: row.quantity,
          };
        }),
      )
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    return {
      id: fileId,
      filename,
      contentType,
      size: params.generation.imageBytes.byteLength,
      url,
      creditsCharged: estimateImageCredits(
        params.generation.model,
        params.generation.billing,
        params.pricing,
      ),
      model: params.generation.model,
      provider: params.generation.provider,
      imageSize: params.generation.imageSize,
      quality: params.generation.quality,
      background: params.generation.background,
      outputFormat: params.generation.outputFormat,
      outputCompression: params.generation.outputCompression,
      moderation: params.generation.moderation,
      safetyTolerance: params.generation.safetyTolerance,
      revisedPrompt: params.generation.revisedPrompt,
      billingCategory: params.generation.billing[0]?.category,
      billingQuantity: params.generation.billing[0]?.quantity,
      sourceUrl: params.generation.sourceUrl,
      seed: params.generation.seed,
      sourceImageUrls: params.generation.sourceImageUrls,
      maskImageUrl: params.generation.maskImageUrl,
      inputFidelity: params.generation.inputFidelity,
      imagePromptStrength: params.generation.imagePromptStrength,
    };
  },
);
