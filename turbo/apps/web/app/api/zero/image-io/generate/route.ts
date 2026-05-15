import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { isApiError } from "@vm0/api-services/errors";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { checkOrgCredits } from "../../../../../src/lib/zero/credit/check-org-credits";
import { processOrgUsageEvents } from "../../../../../src/lib/zero/credit/usage-event-service";
import { uploadS3Buffer } from "../../../../../src/lib/infra/s3/s3-client";
import { buildFileUrl } from "../../../../../src/lib/zero/uploads/file-url";
import { recordGeneratedRunFile } from "../../../../../src/lib/zero/uploads/run-uploaded-files";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  completeRunBuiltInAdmission,
  startRunBuiltInAdmission,
} from "../../../../../src/lib/zero/run-built-in-admission-service";

export const runtime = "nodejs";

const log = logger("api:zero:image-io:generate");

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const FAL_IMAGE_RUN_URL_PREFIX = "https://fal.run";
const DEFAULT_MODEL = "gpt-image-2";
const USAGE_KIND = "image";
const TEXT_INPUT_CATEGORY = "tokens.input.text";
const IMAGE_INPUT_CATEGORY = "tokens.input.image";
const IMAGE_OUTPUT_CATEGORY = "tokens.output.image";
const FAL_OUTPUT_IMAGE_CATEGORY = "output_image";
const FAL_OUTPUT_MEGAPIXEL_CATEGORY = "output_megapixel";
const OPENAI_PRICING_CATEGORIES = [
  TEXT_INPUT_CATEGORY,
  IMAGE_INPUT_CATEGORY,
  IMAGE_OUTPUT_CATEGORY,
] as const;
const IMAGE_PRICING_CATEGORIES = [
  ...OPENAI_PRICING_CATEGORIES,
  FAL_OUTPUT_IMAGE_CATEGORY,
  FAL_OUTPUT_MEGAPIXEL_CATEGORY,
] as const;
const MAX_PROMPT_LENGTH = 32_000;
const MIN_IMAGE_PIXELS = 655_360;
const MAX_IMAGE_PIXELS = 8_294_400;
const MAX_IMAGE_EDGE = 3840;
const IMAGE_EDGE_MULTIPLE = 16;
const MAX_ASPECT_RATIO = 3;

const QUALITIES = ["low", "medium", "high", "auto"] as const;
const BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;
const FAL_OUTPUT_FORMATS = ["png", "jpeg"] as const;
const MODERATIONS = ["auto", "low"] as const;
const SAFETY_TOLERANCES = ["1", "2", "3", "4", "5", "6"] as const;
const STANDARD_OPENAI_IMAGE_SIZES = [
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
] as const;
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
    provider: "openai",
    sizeMode: "flexible",
    sizeParameter: undefined,
    outputFormats: OUTPUT_FORMATS,
    pricingCategories: OPENAI_PRICING_CATEGORIES,
    billingMode: "tokens",
    supportsTransparentBackground: false,
    supportsOutputCompression: true,
    supportsModeration: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
  },
  "gpt-image-1.5": {
    alias: "gpt-image-1.5",
    provider: "openai",
    sizeMode: "standard",
    sizeParameter: undefined,
    outputFormats: OUTPUT_FORMATS,
    pricingCategories: OPENAI_PRICING_CATEGORIES,
    billingMode: "tokens",
    supportsTransparentBackground: true,
    supportsOutputCompression: true,
    supportsModeration: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
  },
  "gpt-image-1": {
    alias: "gpt-image-1",
    provider: "openai",
    sizeMode: "standard",
    sizeParameter: undefined,
    outputFormats: OUTPUT_FORMATS,
    pricingCategories: OPENAI_PRICING_CATEGORIES,
    billingMode: "tokens",
    supportsTransparentBackground: true,
    supportsOutputCompression: true,
    supportsModeration: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
  },
  "gpt-image-1-mini": {
    alias: "gpt-image-1-mini",
    provider: "openai",
    sizeMode: "standard",
    sizeParameter: undefined,
    outputFormats: OUTPUT_FORMATS,
    pricingCategories: OPENAI_PRICING_CATEGORIES,
    billingMode: "tokens",
    supportsTransparentBackground: true,
    supportsOutputCompression: true,
    supportsModeration: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
  },
  "fal-ai/flux-pro/v1.1": {
    alias: "flux-pro-1.1",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: FAL_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_MEGAPIXEL_CATEGORY],
    billingMode: "megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: true,
  },
  "fal-ai/flux-pro/v1.1-ultra": {
    alias: "flux-pro-1.1-ultra",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "aspect_ratio",
    outputFormats: FAL_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: false,
  },
  "fal-ai/qwen-image": {
    alias: "qwen-image",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: FAL_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_MEGAPIXEL_CATEGORY],
    billingMode: "megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
  },
  "fal-ai/bytedance/seedream/v4/text-to-image": {
    alias: "seedream4",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: ["png"],
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
  },
} as const;

const IMAGE_MODELS = Object.keys(IMAGE_MODEL_CONFIGS) as ImageModel[];

type ImageQuality = (typeof QUALITIES)[number];
type ImageBackground = (typeof BACKGROUNDS)[number];
type ImageOutputFormat = (typeof OUTPUT_FORMATS)[number];
type ImageModeration = (typeof MODERATIONS)[number];
type ImageSafetyTolerance = (typeof SAFETY_TOLERANCES)[number];
type ImagePricingCategory = (typeof IMAGE_PRICING_CATEGORIES)[number];
type ImageModel = keyof typeof IMAGE_MODEL_CONFIGS;
type ImageProvider = (typeof IMAGE_MODEL_CONFIGS)[ImageModel]["provider"];
type ImageModelConfig = (typeof IMAGE_MODEL_CONFIGS)[ImageModel];

interface ImageOptions {
  prompt: string;
  model: ImageModel;
  provider: ImageProvider;
  size: string;
  quality: ImageQuality;
  background: ImageBackground;
  outputFormat: ImageOutputFormat;
  outputCompression: number | undefined;
  moderation: ImageModeration;
  seed: number | undefined;
  safetyTolerance: ImageSafetyTolerance;
  enhancePrompt: boolean;
}

interface ImageUsage {
  textInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  totalTokens: number;
}

interface BillingEntry {
  category: ImagePricingCategory;
  quantity: number;
}

interface ImagePricingRow {
  provider: ImageModel;
  category: ImagePricingCategory;
  unitPrice: number;
  unitSize: number;
}

interface ImageOutputOptions {
  outputFormat: ImageOutputFormat;
  outputCompression: number | undefined;
}

interface ParsedImageGeneration {
  imageBytes: Buffer;
  revisedPrompt: string | undefined;
  imageSize: string;
  quality: string;
  background: string;
  outputFormat: ImageOutputFormat;
  outputCompression: number | undefined;
  moderation: ImageModeration;
  safetyTolerance: ImageSafetyTolerance | undefined;
  usage: ImageUsage | undefined;
  billing: readonly BillingEntry[];
  sourceUrl: string | undefined;
  seed: number | undefined;
}

interface OpenAiImageGenerationResponse {
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
  output_format?: string;
  size?: string;
  quality?: string;
  background?: string;
  usage?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      text_tokens?: number;
      image_tokens?: number;
    };
  };
}

interface FalImageFile {
  url: string;
  contentType: string | undefined;
  width: number | undefined;
  height: number | undefined;
}

interface FalImageResult {
  image: FalImageFile;
  revisedPrompt: string | undefined;
  seed: number | undefined;
}

function errorResponse(message: string, code: string, status: number) {
  return NextResponse.json({ error: { message, code } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
): number | undefined | Response {
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
    return errorResponse(`${key} must be an integer`, "BAD_REQUEST", 400);
  }

  return parsed;
}

function readOptionalSafeInteger(
  body: Record<string, unknown>,
  key: string,
): number | undefined | Response {
  const value = readOptionalInteger(body, key);
  if (value instanceof Response) return value;
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    return errorResponse(
      `${key} must be a non-negative safe integer`,
      "BAD_REQUEST",
      400,
    );
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

function imagePricingKey(
  model: ImageModel,
  category: ImagePricingCategory,
): string {
  return `${model}:${category}`;
}

function parseSize(size: string): {
  width: number;
  height: number;
} | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(model: ImageModel, size: string): Response | null {
  if (size === "auto") {
    return null;
  }

  const parsed = parseSize(size);
  if (!parsed) {
    return errorResponse(`Unsupported image size: ${size}`, "BAD_REQUEST", 400);
  }

  const { width, height } = parsed;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  const modelConfig = IMAGE_MODEL_CONFIGS[model];

  if (
    modelConfig.provider === "openai" &&
    modelConfig.sizeMode === "standard" &&
    !hasString(STANDARD_OPENAI_IMAGE_SIZES, size)
  ) {
    return errorResponse(
      `Unsupported image size for ${modelConfig.alias}: ${size}. Use auto, 1024x1024, 1536x1024, or 1024x1536`,
      "BAD_REQUEST",
      400,
    );
  }

  if (longEdge > MAX_IMAGE_EDGE) {
    return errorResponse(
      `Unsupported image size: ${size}; max edge is ${MAX_IMAGE_EDGE}px`,
      "BAD_REQUEST",
      400,
    );
  }
  if (width % IMAGE_EDGE_MULTIPLE !== 0 || height % IMAGE_EDGE_MULTIPLE !== 0) {
    return errorResponse(
      `Unsupported image size: ${size}; both edges must be multiples of ${IMAGE_EDGE_MULTIPLE}px`,
      "BAD_REQUEST",
      400,
    );
  }
  if (longEdge / shortEdge > MAX_ASPECT_RATIO) {
    return errorResponse(
      `Unsupported image size: ${size}; aspect ratio must be at most ${MAX_ASPECT_RATIO}:1`,
      "BAD_REQUEST",
      400,
    );
  }
  if (pixels < MIN_IMAGE_PIXELS || pixels > MAX_IMAGE_PIXELS) {
    return errorResponse(
      `Unsupported image size: ${size}; total pixels must be between ${MIN_IMAGE_PIXELS} and ${MAX_IMAGE_PIXELS}`,
      "BAD_REQUEST",
      400,
    );
  }

  return null;
}

function parsePrompt(body: Record<string, unknown>): string | Response {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    return errorResponse("prompt is required", "BAD_REQUEST", 400);
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return errorResponse(
      `prompt exceeds ${MAX_PROMPT_LENGTH} characters`,
      "BAD_REQUEST",
      400,
    );
  }

  return prompt;
}

function parseImageModel(body: Record<string, unknown>): ImageModel | Response {
  const rawModel = readString(body, "model", DEFAULT_MODEL);
  const model = normalizeImageModel(rawModel);
  if (!model) {
    return errorResponse(
      `Unsupported image model: ${rawModel}. Available models: ${imageModelList()}`,
      "BAD_REQUEST",
      400,
    );
  }

  return model;
}

function parseImageQuality(
  body: Record<string, unknown>,
): ImageQuality | Response {
  const quality = readString(body, "quality", "medium");
  if (!includesString(QUALITIES, quality)) {
    return errorResponse(
      `Unsupported image quality: ${quality}`,
      "BAD_REQUEST",
      400,
    );
  }

  return quality;
}

function parseImageBackground(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageBackground | Response {
  const background = readString(body, "background", "auto");
  if (!includesString(BACKGROUNDS, background)) {
    return errorResponse(
      `Unsupported image background: ${background}`,
      "BAD_REQUEST",
      400,
    );
  }
  if (
    background === "transparent" &&
    !modelConfig.supportsTransparentBackground
  ) {
    return errorResponse(
      `${modelConfig.alias} does not support transparent backgrounds`,
      "BAD_REQUEST",
      400,
    );
  }

  return background;
}

function parseImageOutputOptions(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  background: ImageBackground,
): ImageOutputOptions | Response {
  const outputFormat = readString(body, "outputFormat", "png");
  if (!includesString(OUTPUT_FORMATS, outputFormat)) {
    return errorResponse(
      `Unsupported image output format: ${outputFormat}`,
      "BAD_REQUEST",
      400,
    );
  }
  if (!hasString(modelConfig.outputFormats, outputFormat)) {
    return errorResponse(
      `Unsupported image output format for ${modelConfig.alias}: ${outputFormat}`,
      "BAD_REQUEST",
      400,
    );
  }

  const outputCompression = readOptionalInteger(body, "outputCompression");
  if (outputCompression instanceof Response) return outputCompression;
  if (
    outputCompression !== undefined &&
    (outputCompression < 0 || outputCompression > 100)
  ) {
    return errorResponse(
      "outputCompression must be between 0 and 100",
      "BAD_REQUEST",
      400,
    );
  }
  if (outputCompression !== undefined && outputFormat === "png") {
    return errorResponse(
      "outputCompression is only supported for jpeg or webp output",
      "BAD_REQUEST",
      400,
    );
  }
  if (
    outputCompression !== undefined &&
    !modelConfig.supportsOutputCompression
  ) {
    return errorResponse(
      `outputCompression is not supported for ${modelConfig.alias}`,
      "BAD_REQUEST",
      400,
    );
  }
  if (background === "transparent" && outputFormat === "jpeg") {
    return errorResponse(
      "transparent backgrounds require png or webp output",
      "BAD_REQUEST",
      400,
    );
  }

  return { outputFormat, outputCompression };
}

function parseImageModeration(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageModeration | Response {
  const moderation = readString(body, "moderation", "auto");
  if (!includesString(MODERATIONS, moderation)) {
    return errorResponse(
      `Unsupported image moderation: ${moderation}`,
      "BAD_REQUEST",
      400,
    );
  }
  if (moderation !== "auto" && !modelConfig.supportsModeration) {
    return errorResponse(
      `moderation is not supported for ${modelConfig.alias}`,
      "BAD_REQUEST",
      400,
    );
  }

  return moderation;
}

function parseImageSeed(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): number | undefined | Response {
  const seed = readOptionalSafeInteger(body, "seed");
  if (seed instanceof Response) return seed;
  if (seed !== undefined && !modelConfig.supportsSeed) {
    return errorResponse(
      `seed is not supported for ${modelConfig.alias}`,
      "BAD_REQUEST",
      400,
    );
  }

  return seed;
}

function parseSafetyTolerance(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageSafetyTolerance | Response {
  const safetyTolerance = readString(body, "safetyTolerance", "4");
  if (!includesString(SAFETY_TOLERANCES, safetyTolerance)) {
    return errorResponse(
      `Unsupported safety tolerance: ${safetyTolerance}`,
      "BAD_REQUEST",
      400,
    );
  }
  if (safetyTolerance !== "4" && !modelConfig.supportsSafetyTolerance) {
    return errorResponse(
      `safetyTolerance is not supported for ${modelConfig.alias}`,
      "BAD_REQUEST",
      400,
    );
  }

  return safetyTolerance;
}

function parseEnhancePrompt(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): boolean | Response {
  const enhancePrompt = readBoolean(
    body,
    "enhancePrompt",
    readBoolean(body, "enhance_prompt", false),
  );
  if (enhancePrompt && !modelConfig.supportsEnhancePrompt) {
    return errorResponse(
      `enhancePrompt is not supported for ${modelConfig.alias}`,
      "BAD_REQUEST",
      400,
    );
  }

  return enhancePrompt;
}

function parseImageOptions(body: unknown): ImageOptions | Response {
  if (!isRecord(body)) {
    return errorResponse("Invalid JSON body", "BAD_REQUEST", 400);
  }

  const prompt = parsePrompt(body);
  if (prompt instanceof Response) return prompt;

  const model = parseImageModel(body);
  if (model instanceof Response) return model;
  const modelConfig = IMAGE_MODEL_CONFIGS[model];

  const size = readString(body, "size", "1024x1024");
  const sizeError = validateImageSize(model, size);
  if (sizeError) return sizeError;

  const quality = parseImageQuality(body);
  if (quality instanceof Response) return quality;

  const background = parseImageBackground(body, modelConfig);
  if (background instanceof Response) return background;

  const outputOptions = parseImageOutputOptions(body, modelConfig, background);
  if (outputOptions instanceof Response) return outputOptions;

  const moderation = parseImageModeration(body, modelConfig);
  if (moderation instanceof Response) return moderation;

  const seed = parseImageSeed(body, modelConfig);
  if (seed instanceof Response) return seed;

  const safetyTolerance = parseSafetyTolerance(body, modelConfig);
  if (safetyTolerance instanceof Response) return safetyTolerance;

  const enhancePrompt = parseEnhancePrompt(body, modelConfig);
  if (enhancePrompt instanceof Response) return enhancePrompt;

  return {
    prompt,
    model,
    provider: modelConfig.provider,
    size,
    quality,
    background,
    outputFormat: outputOptions.outputFormat,
    outputCompression: outputOptions.outputCompression,
    moderation,
    seed,
    safetyTolerance,
    enhancePrompt,
  };
}

async function loadImagePricing(): Promise<Map<string, ImagePricingRow>> {
  const rows = await globalThis.services.db
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

function getMissingPricing(
  pricing: Map<string, ImagePricingRow>,
  model: ImageModel,
): readonly ImagePricingCategory[] {
  return IMAGE_MODEL_CONFIGS[model].pricingCategories.filter((category) => {
    return !pricing.has(imagePricingKey(model, category));
  });
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseUsage(
  response: OpenAiImageGenerationResponse,
): ImageUsage | null {
  const usage = response.usage;
  if (!usage) return null;

  const textInputTokens =
    usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
  const imageInputTokens = usage.input_tokens_details?.image_tokens ?? 0;
  const imageOutputTokens = usage.output_tokens ?? 0;
  const totalTokens =
    usage.total_tokens ??
    textInputTokens + imageInputTokens + imageOutputTokens;

  if (
    [textInputTokens, imageInputTokens, imageOutputTokens, totalTokens].some(
      (value) => {
        return !Number.isFinite(value) || value < 0;
      },
    )
  ) {
    return null;
  }
  if (textInputTokens + imageInputTokens + imageOutputTokens <= 0) {
    return null;
  }

  return {
    textInputTokens,
    imageInputTokens,
    imageOutputTokens,
    totalTokens,
  };
}

function openAiBillingEntries(usage: ImageUsage): readonly BillingEntry[] {
  const rows: readonly BillingEntry[] = [
    { category: TEXT_INPUT_CATEGORY, quantity: usage.textInputTokens },
    { category: IMAGE_INPUT_CATEGORY, quantity: usage.imageInputTokens },
    { category: IMAGE_OUTPUT_CATEGORY, quantity: usage.imageOutputTokens },
  ];
  return rows.filter((row) => {
    return row.quantity > 0;
  });
}

function calculateCredits(
  model: ImageModel,
  billing: readonly BillingEntry[],
  pricing: Map<string, ImagePricingRow>,
): number {
  return billing.reduce((total, row) => {
    if (row.quantity <= 0) return total;
    const pricingRow = pricing.get(imagePricingKey(model, row.category));
    if (!pricingRow) return total;
    return (
      total +
      Math.ceil((row.quantity * pricingRow.unitPrice) / pricingRow.unitSize)
    );
  }, 0);
}

function contentTypeForFormat(format: ImageOutputFormat): string {
  if (format === "webp") return "image/webp";
  if (format === "jpeg") return "image/jpeg";
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
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/jpeg") return "jpeg";
  return "png";
}

function extensionForFormat(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function outputCompressionField(options: ImageOptions) {
  return options.outputCompression !== undefined
    ? { outputCompression: options.outputCompression }
    : {};
}

function openAiRequestBody(options: ImageOptions) {
  return {
    model: options.model,
    prompt: options.prompt,
    n: 1,
    size: options.size,
    quality: options.quality,
    background: options.background,
    output_format: options.outputFormat,
    ...(options.outputCompression !== undefined
      ? { output_compression: options.outputCompression }
      : {}),
    moderation: options.moderation,
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
  if (options.size === "auto") {
    return "landscape_4_3";
  }
  const parsed = parseSize(options.size);
  if (!parsed) {
    return "landscape_4_3";
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
    ...(modelConfig.supportsSeed && options.seed !== undefined
      ? { seed: options.seed }
      : {}),
    ...(modelConfig.supportsSafetyTolerance
      ? { safety_tolerance: options.safetyTolerance }
      : {}),
    ...(modelConfig.supportsEnhancePrompt
      ? { enhance_prompt: options.enhancePrompt }
      : {}),
  };
}

async function generateOpenAiImage(
  options: ImageOptions,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | Response> {
  const response = await fetch(OPENAI_IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env().OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openAiRequestBody(options)),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log.error("OpenAI image request failed", {
      status: response.status,
      body: errorBody,
    });
    return errorResponse(
      "Image generation failed",
      "INTERNAL_SERVER_ERROR",
      500,
    );
  }

  const responseBody = (await response.json()) as OpenAiImageGenerationResponse;
  const image = responseBody.data?.[0];
  if (!image?.b64_json) {
    return errorResponse(
      "Model returned no image data",
      "NO_IMAGE_RETURNED",
      502,
    );
  }

  const usage = parseUsage(responseBody);
  if (!usage) {
    log.error("OpenAI image response missing usage", { responseBody });
    return errorResponse(
      "Image generation usage was not returned",
      "USAGE_UNKNOWN",
      502,
    );
  }

  const imageBytes = Buffer.from(image.b64_json, "base64");
  if (imageBytes.byteLength === 0) {
    return errorResponse(
      "Model returned empty image",
      "NO_IMAGE_RETURNED",
      502,
    );
  }

  const outputFormat =
    responseBody.output_format &&
    includesString(OUTPUT_FORMATS, responseBody.output_format)
      ? responseBody.output_format
      : options.outputFormat;

  return {
    imageBytes,
    revisedPrompt: image.revised_prompt,
    imageSize: responseBody.size ?? options.size,
    quality: responseBody.quality ?? options.quality,
    background: responseBody.background ?? options.background,
    outputFormat,
    outputCompression: options.outputCompression,
    moderation: options.moderation,
    safetyTolerance: undefined,
    usage,
    billing: openAiBillingEntries(usage),
    sourceUrl: undefined,
    seed: options.seed,
  };
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

function parseFalImageResult(value: unknown): FalImageResult | Response {
  if (!isRecord(value) || !Array.isArray(value.images)) {
    return errorResponse(
      "Model returned no image data",
      "NO_IMAGE_RETURNED",
      502,
    );
  }

  const image = parseFalImageFile(value.images[0]);
  if (!image) {
    return errorResponse(
      "Model returned no image data",
      "NO_IMAGE_RETURNED",
      502,
    );
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
): readonly BillingEntry[] {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  if (modelConfig.billingMode === "megapixel") {
    return [
      {
        category: FAL_OUTPUT_MEGAPIXEL_CATEGORY,
        quantity: megapixelsForImage(image, options),
      },
    ];
  }
  return [{ category: FAL_OUTPUT_IMAGE_CATEGORY, quantity: 1 }];
}

async function generateFalImage(
  options: ImageOptions,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | Response> {
  const falKey = env().FAL_KEY;
  if (!falKey) {
    return errorResponse(
      "Fal image generation is not configured",
      "NOT_CONFIGURED",
      503,
    );
  }

  const response = await fetch(`${FAL_IMAGE_RUN_URL_PREFIX}/${options.model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(falImageInput(options)),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log.error("Fal image request failed", {
      model: options.model,
      status: response.status,
      body: errorBody,
    });
    return errorResponse(
      "Image generation failed",
      "INTERNAL_SERVER_ERROR",
      500,
    );
  }

  const falResult = parseFalImageResult(await response.json());
  if (falResult instanceof Response) return falResult;

  const imageResponse = await fetch(falResult.image.url, {
    method: "GET",
    signal,
  });
  if (!imageResponse.ok) {
    return errorResponse(
      "Could not download generated image",
      "IMAGE_DOWNLOAD_FAILED",
      502,
    );
  }

  const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
  if (imageBytes.byteLength === 0) {
    return errorResponse(
      "Model returned empty image",
      "NO_IMAGE_RETURNED",
      502,
    );
  }

  const contentType =
    normalizeImageContentType(falResult.image.contentType) ??
    normalizeImageContentType(imageResponse.headers.get("content-type")) ??
    contentTypeForFormat(options.outputFormat);
  const outputFormat = formatForContentType(contentType);
  const imageSize =
    falResult.image.width && falResult.image.height
      ? `${falResult.image.width}x${falResult.image.height}`
      : options.size;

  return {
    imageBytes,
    revisedPrompt: falResult.revisedPrompt,
    imageSize,
    quality: "model-default",
    background: "auto",
    outputFormat,
    outputCompression: undefined,
    moderation: options.moderation,
    safetyTolerance: IMAGE_MODEL_CONFIGS[options.model].supportsSafetyTolerance
      ? options.safetyTolerance
      : undefined,
    usage: undefined,
    billing: falBillingEntries(falResult.image, options),
    sourceUrl: falResult.image.url,
    seed: falResult.seed ?? options.seed,
  };
}

function imageMetadata(
  generation: ParsedImageGeneration,
  options: ImageOptions,
) {
  return {
    generatedBy: "zero-official-image",
    model: options.model,
    provider: options.provider,
    imageSize: generation.imageSize,
    quality: generation.quality,
    background: generation.background,
    outputFormat: generation.outputFormat,
    ...outputCompressionField(options),
    moderation: generation.moderation,
    safetyTolerance: generation.safetyTolerance,
    sourceUrl: generation.sourceUrl,
    seed: generation.seed,
  };
}

async function handlePost(request: Request): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { requiredCapability: "file:write" },
  );
  if (!authCtx) {
    return errorResponse("Not authenticated", "UNAUTHORIZED", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", "BAD_REQUEST", 400);
  }

  const options = parseImageOptions(body);
  if (options instanceof Response) return options;

  const { org } = await resolveOrg(authCtx);
  const db = globalThis.services.db;
  await checkOrgCredits(org.orgId, authCtx.userId, db);

  const pricing = await loadImagePricing();
  const missingPricing = getMissingPricing(pricing, options.model);
  if (missingPricing.length > 0) {
    return errorResponse(
      "Image generation pricing is not configured",
      "NOT_CONFIGURED",
      503,
    );
  }

  const admission = await startRunBuiltInAdmission(db, {
    runId: authCtx.runId,
    kind: "image",
  });
  if (admission instanceof Response) return admission;

  let admissionStatus: "completed" | "failed" = "failed";
  try {
    const generation =
      options.provider === "fal"
        ? await generateFalImage(options, request.signal)
        : await generateOpenAiImage(options, request.signal);
    if (generation instanceof Response) return generation;

    const contentType = contentTypeForFormat(generation.outputFormat);
    const fileId = randomUUID();
    const filename = `image-${fileId.slice(0, 8)}.${extensionForFormat(
      generation.outputFormat,
    )}`;
    const s3Key = `uploads/${authCtx.userId}/${fileId}/${filename}`;
    const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
    await uploadS3Buffer(bucket, s3Key, generation.imageBytes, contentType);
    const url = buildFileUrl(authCtx.userId, fileId, filename);

    await recordGeneratedRunFile({
      runId: authCtx.runId,
      externalId: fileId,
      userId: authCtx.userId,
      orgId: authCtx.orgId,
      filename,
      contentType,
      sizeBytes: generation.imageBytes.byteLength,
      url,
      s3Key,
      metadata: imageMetadata(generation, options),
    });

    const usageRows = generation.billing.filter((row) => {
      return row.quantity > 0;
    });

    await db.insert(usageEvent).values(
      usageRows.map((row) => {
        return {
          runId: authCtx.runId ?? null,
          idempotencyKey: randomUUID(),
          orgId: org.orgId,
          userId: authCtx.userId,
          kind: USAGE_KIND,
          provider: options.model,
          category: row.category,
          quantity: row.quantity,
        };
      }),
    );
    await processOrgUsageEvents(org.orgId);
    admissionStatus = "completed";

    return NextResponse.json({
      id: fileId,
      filename,
      contentType,
      size: generation.imageBytes.byteLength,
      url,
      creditsCharged: calculateCredits(
        options.model,
        generation.billing,
        pricing,
      ),
      model: options.model,
      provider: options.provider,
      imageSize: generation.imageSize,
      quality: generation.quality,
      background: generation.background,
      outputFormat: generation.outputFormat,
      outputCompression: generation.outputCompression,
      moderation: generation.moderation,
      safetyTolerance: generation.safetyTolerance,
      revisedPrompt: generation.revisedPrompt,
      usage: generation.usage,
      billingCategory: generation.billing[0]?.category,
      billingQuantity: generation.billing[0]?.quantity,
      sourceUrl: generation.sourceUrl,
      seed: generation.seed,
    });
  } finally {
    await completeRunBuiltInAdmission(db, {
      admission,
      status: admissionStatus,
    });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handlePost(request);
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    throw error;
  }
}
