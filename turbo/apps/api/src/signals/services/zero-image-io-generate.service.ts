import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";

import { buildFileUrl } from "../../lib/file-url";
import { env } from "../../lib/env";
import { db$, writeDb$ } from "../external/db";
import { putS3Object } from "../external/s3";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

export const OPENAI_IMAGE_GENERATION_URL =
  "https://api.openai.com/v1/images/generations";
export const IMAGE_IO_MODEL = "gpt-image-2";
const IMAGE_IO_MAX_PROMPT_LENGTH = 32_000;

const USAGE_KIND = "image";
const USAGE_PROVIDER = IMAGE_IO_MODEL;
const TEXT_INPUT_CATEGORY = "tokens.input.text";
const IMAGE_INPUT_CATEGORY = "tokens.input.image";
const IMAGE_OUTPUT_CATEGORY = "tokens.output.image";
const REQUIRED_PRICING_CATEGORIES = [
  TEXT_INPUT_CATEGORY,
  IMAGE_INPUT_CATEGORY,
  IMAGE_OUTPUT_CATEGORY,
] as const;

const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
const IMAGE_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const IMAGE_OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;

type ImageSize = (typeof IMAGE_SIZES)[number];
type ImageQuality = (typeof IMAGE_QUALITIES)[number];
type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];
type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
type PricingCategory = (typeof REQUIRED_PRICING_CATEGORIES)[number];

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
  readonly unitPrice: number;
  readonly unitSize: number;
}

export type ImagePricing = ReadonlyMap<PricingCategory, ImagePricingRow>;

interface ImageOptions {
  readonly prompt: string;
  readonly size: ImageSize;
  readonly quality: ImageQuality;
  readonly background: ImageBackground;
  readonly outputFormat: ImageOutputFormat;
}

export interface ImageUsage {
  readonly textInputTokens: number;
  readonly imageInputTokens: number;
  readonly imageOutputTokens: number;
  readonly totalTokens: number;
}

interface ParsedImageGeneration {
  readonly imageBytes: Buffer;
  readonly revisedPrompt: string | undefined;
  readonly imageSize: string;
  readonly quality: string;
  readonly background: string;
  readonly outputFormat: ImageOutputFormat;
  readonly usage: ImageUsage;
}

interface RecordedImage {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly creditsCharged: number;
  readonly model: string;
  readonly imageSize: string;
  readonly quality: string;
  readonly background: string;
  readonly outputFormat: ImageOutputFormat;
  readonly revisedPrompt: string | undefined;
  readonly usage: ImageUsage;
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

export function internalError(message: string) {
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

function includesString<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return values.some((candidate) => {
    return candidate === value;
  });
}

export function parseImageOptions(body: unknown): ImageOptions | ErrorResponse {
  if (!isRecord(body)) {
    return badRequest("Invalid JSON body");
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    return badRequest("prompt is required");
  }
  if (prompt.length > IMAGE_IO_MAX_PROMPT_LENGTH) {
    return badRequest(
      `prompt exceeds ${IMAGE_IO_MAX_PROMPT_LENGTH} characters`,
    );
  }

  const size = readString(body, "size", "1024x1024");
  if (!includesString(IMAGE_SIZES, size)) {
    return badRequest(`Unsupported image size: ${size}`);
  }

  const quality = readString(body, "quality", "medium");
  if (!includesString(IMAGE_QUALITIES, quality)) {
    return badRequest(`Unsupported image quality: ${quality}`);
  }

  const background = readString(body, "background", "auto");
  if (!includesString(IMAGE_BACKGROUNDS, background)) {
    return badRequest(`Unsupported image background: ${background}`);
  }

  const outputFormat = readString(body, "outputFormat", "png");
  if (!includesString(IMAGE_OUTPUT_FORMATS, outputFormat)) {
    return badRequest(`Unsupported image output format: ${outputFormat}`);
  }
  if (background === "transparent" && outputFormat === "jpeg") {
    return badRequest("transparent background requires png or webp output");
  }

  return { prompt, size, quality, background, outputFormat };
}

function mapPricingRows(
  rows: readonly (ImagePricingRow & { readonly category: string })[],
): ImagePricing {
  const pricing = new Map<PricingCategory, ImagePricingRow>();
  for (const row of rows) {
    if (includesString(REQUIRED_PRICING_CATEGORIES, row.category)) {
      pricing.set(row.category, {
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }
  return pricing;
}

function getMissingPricing(pricing: ImagePricing): readonly PricingCategory[] {
  return REQUIRED_PRICING_CATEGORIES.filter((category) => {
    return !pricing.has(category);
  });
}

export const imagePricing$: Computed<Promise<ImagePricing | null>> = computed(
  async (get): Promise<ImagePricing | null> => {
    const db = get(db$);
    const rows = await db
      .select({
        category: usagePricing.category,
        unitPrice: usagePricing.unitPrice,
        unitSize: usagePricing.unitSize,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, USAGE_KIND),
          eq(usagePricing.provider, USAGE_PROVIDER),
          inArray(usagePricing.category, [...REQUIRED_PRICING_CATEGORIES]),
        ),
      );

    const pricing = mapPricingRows(rows);
    return getMissingPricing(pricing).length === 0 ? pricing : null;
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

export function parseImageGenerationResult(
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
    imageBytes,
    revisedPrompt: image.revised_prompt,
    imageSize: response.size ?? options.size,
    quality: response.quality ?? options.quality,
    background: response.background ?? options.background,
    outputFormat,
    usage,
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

function extensionForFormat(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function estimateImageCredits(
  usage: ImageUsage,
  pricing: ImagePricing,
): number {
  const rows: readonly (readonly [PricingCategory, number])[] = [
    [TEXT_INPUT_CATEGORY, usage.textInputTokens],
    [IMAGE_INPUT_CATEGORY, usage.imageInputTokens],
    [IMAGE_OUTPUT_CATEGORY, usage.imageOutputTokens],
  ];

  return rows.reduce((total, [category, quantity]) => {
    if (quantity <= 0) {
      return total;
    }
    const row = pricing.get(category);
    if (!row) {
      return total;
    }
    return total + Math.ceil((quantity * row.unitPrice) / row.unitSize);
  }, 0);
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
          model: IMAGE_IO_MODEL,
          imageSize: params.generation.imageSize,
          quality: params.generation.quality,
          background: params.generation.background,
          outputFormat: params.generation.outputFormat,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    const usageRows = [
      {
        category: TEXT_INPUT_CATEGORY,
        quantity: params.generation.usage.textInputTokens,
      },
      {
        category: IMAGE_INPUT_CATEGORY,
        quantity: params.generation.usage.imageInputTokens,
      },
      {
        category: IMAGE_OUTPUT_CATEGORY,
        quantity: params.generation.usage.imageOutputTokens,
      },
    ].filter((row) => {
      return row.quantity > 0;
    });

    await writeDb.insert(usageEvent).values(
      usageRows.map((row) => {
        return {
          runId: null,
          idempotencyKey: randomUUID(),
          orgId: params.orgId,
          userId: params.userId,
          kind: USAGE_KIND,
          provider: USAGE_PROVIDER,
          category: row.category,
          quantity: row.quantity,
        };
      }),
    );
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
        params.generation.usage,
        params.pricing,
      ),
      model: IMAGE_IO_MODEL,
      imageSize: params.generation.imageSize,
      quality: params.generation.quality,
      background: params.generation.background,
      outputFormat: params.generation.outputFormat,
      revisedPrompt: params.generation.revisedPrompt,
      usage: params.generation.usage,
    };
  },
);
