import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";

import { buildFileUrl } from "../../lib/file-url";
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

export const OPENAI_IMAGE_GENERATION_URL =
  "https://api.openai.com/v1/images/generations";
const FAL_IMAGE_RUN_URL_PREFIX = "https://fal.run";
export const IMAGE_IO_MODEL = "gpt-image-1";
const IMAGE_IO_MAX_PROMPT_LENGTH = 32_000;
const IMAGE_IO_MIN_PIXELS = 655_360;
const IMAGE_IO_MAX_PIXELS = 8_294_400;
const IMAGE_IO_MAX_EDGE = 3840;
const IMAGE_IO_EDGE_MULTIPLE = 16;
const IMAGE_IO_MAX_ASPECT_RATIO = 3;

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

const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
const IMAGE_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const IMAGE_OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;
const IMAGE_MODERATIONS = ["auto", "low"] as const;
const IMAGE_SAFETY_TOLERANCES = ["1", "2", "3", "4", "5", "6"] as const;
const STANDARD_OPENAI_IMAGE_SIZES = [
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
    provider: "openai",
    sizeMode: "flexible",
    sizeParameter: undefined,
    outputFormats: IMAGE_OUTPUT_FORMATS,
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
    outputFormats: IMAGE_OUTPUT_FORMATS,
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
    outputFormats: IMAGE_OUTPUT_FORMATS,
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
    outputFormats: IMAGE_OUTPUT_FORMATS,
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
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
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
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
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
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
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
const L = logger("ZeroImageIoGenerate");

type ImageQuality = (typeof IMAGE_QUALITIES)[number];
type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];
type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
type ImageModeration = (typeof IMAGE_MODERATIONS)[number];
type ImageSafetyTolerance = (typeof IMAGE_SAFETY_TOLERANCES)[number];
type ImagePricingCategory = (typeof IMAGE_PRICING_CATEGORIES)[number];
export type ImageModel = keyof typeof IMAGE_MODEL_CONFIGS;
export type ImageProvider =
  (typeof IMAGE_MODEL_CONFIGS)[ImageModel]["provider"];
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
}

export interface ImageUsage {
  readonly textInputTokens: number;
  readonly imageInputTokens: number;
  readonly imageOutputTokens: number;
  readonly totalTokens: number;
}

export interface ParsedImageGeneration {
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
  readonly usage: ImageUsage | undefined;
  readonly billing: readonly ImageBillingEntry[];
  readonly sourceUrl: string | undefined;
  readonly seed: number | undefined;
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
  readonly usage: ImageUsage | undefined;
  readonly billingCategory: string | undefined;
  readonly billingQuantity: number | undefined;
  readonly sourceUrl: string | undefined;
  readonly seed: number | undefined;
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

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

interface OpenAiImageGenerationResponse {
  readonly data?: readonly OpenAiImageData[];
  readonly output_format?: string;
  readonly size?: string;
  readonly quality?: string;
  readonly background?: string;
  readonly usage?: OpenAiImageUsage;
}

interface OpenAiImageData {
  readonly b64_json?: string;
  readonly revised_prompt?: string;
}

interface OpenAiImageUsage {
  readonly total_tokens?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly input_tokens_details?: {
    readonly text_tokens?: number;
    readonly image_tokens?: number;
  };
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string, code = "BAD_REQUEST") {
  return { status: 400 as const, body: errorBody(message, code) };
}

function internalError(message: string) {
  return {
    status: 500 as const,
    body: errorBody(message, "INTERNAL_SERVER_ERROR"),
  };
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

function isErrorResponse(value: unknown): value is ErrorResponse {
  return isRecord(value) && "status" in value && "body" in value;
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

export function normalizeImageModel(value: string): ImageModel | null {
  if (value in IMAGE_MODEL_CONFIGS) {
    return value as ImageModel;
  }
  if (value in IMAGE_MODEL_ALIASES) {
    return IMAGE_MODEL_ALIASES[value as keyof typeof IMAGE_MODEL_ALIASES];
  }
  return null;
}

export function imageModelList(): string {
  return Object.keys(IMAGE_MODEL_ALIASES).join(", ");
}

export function imageModelConfig(model: ImageModel): ImageModelConfig {
  return IMAGE_MODEL_CONFIGS[model];
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
    modelConfig.provider === "openai" &&
    modelConfig.sizeMode === "standard" &&
    !hasString(STANDARD_OPENAI_IMAGE_SIZES, size)
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

  const size = readString(body, "size", "1024x1024");
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
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const { rows } = await writeDb.execute<CreditCheckRow>(sql`
      WITH member AS (
        SELECT credit_enabled FROM org_members_metadata
        WHERE org_id = ${args.orgId} AND user_id = ${args.userId}
        LIMIT 1
      ),
      org AS (
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
        (SELECT credit_enabled FROM member) AS credit_enabled,
        (SELECT credits FROM org) AS credits,
        (SELECT total FROM expired) AS unsettled_expired
    `);
    signal.throwIfAborted();

    const row = rows[0];
    if (!row || row.credit_enabled === false || row.credits === null) {
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

function readOpenAiUsage(value: unknown): OpenAiImageUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const details = isRecord(value.input_tokens_details)
    ? {
        text_tokens: readNumber(value.input_tokens_details.text_tokens),
        image_tokens: readNumber(value.input_tokens_details.image_tokens),
      }
    : undefined;

  return {
    total_tokens: readNumber(value.total_tokens),
    input_tokens: readNumber(value.input_tokens),
    output_tokens: readNumber(value.output_tokens),
    input_tokens_details: details,
  };
}

function parseUsage(usage: OpenAiImageUsage | undefined): ImageUsage | null {
  if (!usage) {
    return null;
  }

  const textInputTokens =
    usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
  const imageInputTokens = usage.input_tokens_details?.image_tokens ?? 0;
  const imageOutputTokens = usage.output_tokens ?? 0;
  const totalTokens =
    usage.total_tokens ??
    textInputTokens + imageInputTokens + imageOutputTokens;

  const values = [
    textInputTokens,
    imageInputTokens,
    imageOutputTokens,
    totalTokens,
  ];
  if (
    values.some((value) => {
      return !Number.isFinite(value) || value < 0;
    })
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

function parseOpenAiResponse(value: unknown): OpenAiImageGenerationResponse {
  if (!isRecord(value)) {
    return {};
  }

  const data = Array.isArray(value.data)
    ? value.data.flatMap((item): OpenAiImageData[] => {
        if (!isRecord(item)) {
          return [];
        }
        return [
          {
            b64_json:
              typeof item.b64_json === "string" ? item.b64_json : undefined,
            revised_prompt:
              typeof item.revised_prompt === "string"
                ? item.revised_prompt
                : undefined,
          },
        ];
      })
    : undefined;

  return {
    data,
    output_format:
      typeof value.output_format === "string" ? value.output_format : undefined,
    size: typeof value.size === "string" ? value.size : undefined,
    quality: typeof value.quality === "string" ? value.quality : undefined,
    background:
      typeof value.background === "string" ? value.background : undefined,
    usage: readOpenAiUsage(value.usage),
  };
}

function openAiBillingEntries(usage: ImageUsage): readonly ImageBillingEntry[] {
  const rows: readonly ImageBillingEntry[] = [
    { category: TEXT_INPUT_CATEGORY, quantity: usage.textInputTokens },
    { category: IMAGE_INPUT_CATEGORY, quantity: usage.imageInputTokens },
    { category: IMAGE_OUTPUT_CATEGORY, quantity: usage.imageOutputTokens },
  ];
  return rows.filter((row) => {
    return row.quantity > 0;
  });
}

function parseImageGenerationResult(
  value: unknown,
  options: ImageOptions,
): ParsedImageGeneration | ErrorResponse {
  const response = parseOpenAiResponse(value);
  const image = response.data?.[0];
  if (!image?.b64_json) {
    return badGateway("Model returned no image data", "NO_IMAGE_RETURNED");
  }

  const usage = parseUsage(response.usage);
  if (!usage) {
    return badGateway(
      "Image generation usage was not returned",
      "USAGE_UNKNOWN",
    );
  }

  const imageBytes = Buffer.from(image.b64_json, "base64");
  if (imageBytes.byteLength === 0) {
    return badGateway("Model returned empty image", "NO_IMAGE_RETURNED");
  }

  const outputFormat =
    response.output_format &&
    includesString(IMAGE_OUTPUT_FORMATS, response.output_format)
      ? response.output_format
      : options.outputFormat;

  return {
    model: options.model,
    provider: "openai",
    imageBytes,
    revisedPrompt: image.revised_prompt,
    imageSize: response.size ?? options.size,
    quality: response.quality ?? options.quality,
    background: response.background ?? options.background,
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

async function submitFalImageGeneration(
  options: ImageOptions,
  falKey: string,
  signal: AbortSignal,
): Promise<unknown | ErrorResponse> {
  const response = await fetch(`${FAL_IMAGE_RUN_URL_PREFIX}/${options.model}`, {
    method: "POST",
    headers: falHeaders(falKey),
    body: JSON.stringify(falImageInput(options)),
    signal,
  });

  if (!response.ok) {
    return internalError("Image generation failed");
  }

  return await response.json();
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

function parseFalImageResult(value: unknown): FalImageResult | ErrorResponse {
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
  return [{ category: FAL_OUTPUT_IMAGE_CATEGORY, quantity: 1 }];
}

async function downloadFalImage(
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

  return {
    model: options.model,
    provider: "fal",
    imageBytes,
    revisedPrompt: result.revisedPrompt,
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
    billing: falBillingEntries(result.image, options),
    sourceUrl: result.image.url,
    seed: result.seed ?? options.seed,
  };
}

async function generateOpenAiImage(
  options: ImageOptions,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | ErrorResponse> {
  const response = await fetch(OPENAI_IMAGE_GENERATION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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
    }),
    signal,
  });
  signal.throwIfAborted();

  if (!response.ok) {
    const errorBody = await response.text();
    signal.throwIfAborted();
    L.error("OpenAI image request failed", {
      status: response.status,
      body: errorBody,
    });
    return internalError("Image generation failed");
  }

  const responseBody: unknown = await response.json();
  signal.throwIfAborted();
  const generation = parseImageGenerationResult(responseBody, options);
  if (
    "status" in generation &&
    generation.body.error.code === "USAGE_UNKNOWN"
  ) {
    L.error("OpenAI image response missing usage", { responseBody });
  }
  return generation;
}

async function generateFalImage(
  options: ImageOptions,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | ErrorResponse> {
  const falKey = env("FAL_KEY");
  if (!falKey) {
    return serviceUnavailable(
      "Fal image generation is not configured",
      "NOT_CONFIGURED",
    );
  }

  const responseBody = await submitFalImageGeneration(options, falKey, signal);
  signal.throwIfAborted();
  if (isErrorResponse(responseBody)) {
    return responseBody;
  }

  const falResult = parseFalImageResult(responseBody);
  if ("status" in falResult) {
    return falResult;
  }
  return await downloadFalImage(falResult, options, signal);
}

export function generateImageWithProvider(
  options: ImageOptions,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | ErrorResponse> {
  return options.provider === "fal"
    ? generateFalImage(options, signal)
    : generateOpenAiImage(options, signal);
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
    const s3Key = `uploads/${params.userId}/${fileId}/${filename}`;
    const contentType = contentTypeForFormat(params.generation.outputFormat);
    await get(
      putS3Object(
        env("R2_USER_STORAGES_BUCKET_NAME"),
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
      usage: params.generation.usage,
      billingCategory: params.generation.billing[0]?.category,
      billingQuantity: params.generation.billing[0]?.quantity,
      sourceUrl: params.generation.sourceUrl,
      seed: params.generation.seed,
    };
  },
);
