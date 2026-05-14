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

export const runtime = "nodejs";

const log = logger("api:zero:image-io:generate");

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const MODEL = "gpt-image-2";
const USAGE_KIND = "image";
const USAGE_PROVIDER = MODEL;
const TEXT_INPUT_CATEGORY = "tokens.input.text";
const IMAGE_INPUT_CATEGORY = "tokens.input.image";
const IMAGE_OUTPUT_CATEGORY = "tokens.output.image";
const REQUIRED_PRICING_CATEGORIES = [
  TEXT_INPUT_CATEGORY,
  IMAGE_INPUT_CATEGORY,
  IMAGE_OUTPUT_CATEGORY,
] as const;
const MAX_PROMPT_LENGTH = 32_000;
const MIN_IMAGE_PIXELS = 655_360;
const MAX_IMAGE_PIXELS = 8_294_400;
const MAX_IMAGE_EDGE = 3840;
const IMAGE_EDGE_MULTIPLE = 16;
const MAX_ASPECT_RATIO = 3;

const QUALITIES = new Set(["low", "medium", "high", "auto"]);
const BACKGROUNDS = new Set(["auto", "opaque"]);
const OUTPUT_FORMATS = new Set(["png", "webp", "jpeg"]);
const MODERATIONS = new Set(["auto", "low"]);

type PricingCategory = (typeof REQUIRED_PRICING_CATEGORIES)[number];

interface ImageOptions {
  prompt: string;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  outputCompression: number | undefined;
  moderation: string;
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

interface ImageUsage {
  textInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  totalTokens: number;
}

function errorResponse(message: string, code: string, status: number) {
  return NextResponse.json({ error: { message, code } }, { status });
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

function validateImageSize(size: string): Response | null {
  if (size === "auto") {
    return null;
  }

  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    return errorResponse(`Unsupported image size: ${size}`, "BAD_REQUEST", 400);
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;

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

function parseImageOptions(body: unknown): ImageOptions | Response {
  if (!isRecord(body)) {
    return errorResponse("Invalid JSON body", "BAD_REQUEST", 400);
  }

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

  const size = readString(body, "size", "1024x1024");
  const sizeError = validateImageSize(size);
  if (sizeError) return sizeError;

  const quality = readString(body, "quality", "medium");
  if (!QUALITIES.has(quality)) {
    return errorResponse(
      `Unsupported image quality: ${quality}`,
      "BAD_REQUEST",
      400,
    );
  }

  const background = readString(body, "background", "auto");
  if (background === "transparent") {
    return errorResponse(
      "gpt-image-2 does not support transparent backgrounds",
      "BAD_REQUEST",
      400,
    );
  }
  if (!BACKGROUNDS.has(background)) {
    return errorResponse(
      `Unsupported image background: ${background}`,
      "BAD_REQUEST",
      400,
    );
  }

  const outputFormat = readString(body, "outputFormat", "png");
  if (!OUTPUT_FORMATS.has(outputFormat)) {
    return errorResponse(
      `Unsupported image output format: ${outputFormat}`,
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

  const moderation = readString(body, "moderation", "auto");
  if (!MODERATIONS.has(moderation)) {
    return errorResponse(
      `Unsupported image moderation: ${moderation}`,
      "BAD_REQUEST",
      400,
    );
  }

  return {
    prompt,
    size,
    quality,
    background,
    outputFormat,
    outputCompression,
    moderation,
  };
}

async function loadImagePricing(): Promise<
  Map<PricingCategory, { unitPrice: number; unitSize: number }>
> {
  const rows = await globalThis.services.db
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

  const pricing = new Map<
    PricingCategory,
    { unitPrice: number; unitSize: number }
  >();
  for (const row of rows) {
    if (REQUIRED_PRICING_CATEGORIES.includes(row.category as PricingCategory)) {
      pricing.set(row.category as PricingCategory, {
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }

  return pricing;
}

function getMissingPricing(
  pricing: Map<PricingCategory, { unitPrice: number; unitSize: number }>,
): string[] {
  return REQUIRED_PRICING_CATEGORIES.filter((category) => {
    return !pricing.has(category);
  });
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

function calculateCredits(
  usage: ImageUsage,
  pricing: Map<PricingCategory, { unitPrice: number; unitSize: number }>,
): number {
  const rows: Array<[PricingCategory, number]> = [
    [TEXT_INPUT_CATEGORY, usage.textInputTokens],
    [IMAGE_INPUT_CATEGORY, usage.imageInputTokens],
    [IMAGE_OUTPUT_CATEGORY, usage.imageOutputTokens],
  ];

  return rows.reduce((total, [category, quantity]) => {
    if (quantity <= 0) return total;
    const row = pricing.get(category);
    if (!row) return total;
    return total + Math.ceil((quantity * row.unitPrice) / row.unitSize);
  }, 0);
}

function contentTypeForFormat(format: string): string {
  if (format === "webp") return "image/webp";
  if (format === "jpeg") return "image/jpeg";
  return "image/png";
}

function extensionForFormat(format: string): string {
  return format === "jpeg" ? "jpg" : format;
}

function outputCompressionField(options: ImageOptions) {
  return options.outputCompression !== undefined
    ? { outputCompression: options.outputCompression }
    : {};
}

function openAiRequestBody(options: ImageOptions) {
  return {
    model: MODEL,
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

function imageMetadata(
  responseBody: OpenAiImageGenerationResponse,
  options: ImageOptions,
  outputFormat: string,
) {
  return {
    generatedBy: "zero-official-image",
    model: MODEL,
    imageSize: responseBody.size ?? options.size,
    quality: responseBody.quality ?? options.quality,
    background: responseBody.background ?? options.background,
    outputFormat,
    ...outputCompressionField(options),
    moderation: options.moderation,
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
  const missingPricing = getMissingPricing(pricing);
  if (missingPricing.length > 0) {
    return errorResponse(
      `Image generation pricing is not configured: ${missingPricing.join(", ")}`,
      "NOT_CONFIGURED",
      503,
    );
  }

  const openaiResponse = await fetch(OPENAI_IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env().OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openAiRequestBody(options)),
    signal: request.signal,
  });

  if (!openaiResponse.ok) {
    const errorBody = await openaiResponse.text();
    log.error("OpenAI image request failed", {
      status: openaiResponse.status,
      body: errorBody,
    });
    return errorResponse(
      "Image generation failed",
      "INTERNAL_SERVER_ERROR",
      500,
    );
  }

  const responseBody =
    (await openaiResponse.json()) as OpenAiImageGenerationResponse;
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
    responseBody.output_format && OUTPUT_FORMATS.has(responseBody.output_format)
      ? responseBody.output_format
      : options.outputFormat;
  const contentType = contentTypeForFormat(outputFormat);
  const fileId = randomUUID();
  const filename = `image-${fileId.slice(0, 8)}.${extensionForFormat(
    outputFormat,
  )}`;
  const s3Key = `uploads/${authCtx.userId}/${fileId}/${filename}`;
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  await uploadS3Buffer(bucket, s3Key, imageBytes, contentType);
  const url = buildFileUrl(authCtx.userId, fileId, filename);

  await recordGeneratedRunFile({
    runId: authCtx.runId,
    externalId: fileId,
    userId: authCtx.userId,
    orgId: authCtx.orgId,
    filename,
    contentType,
    sizeBytes: imageBytes.byteLength,
    url,
    s3Key,
    metadata: imageMetadata(responseBody, options, outputFormat),
  });

  const usageRows = [
    { category: TEXT_INPUT_CATEGORY, quantity: usage.textInputTokens },
    { category: IMAGE_INPUT_CATEGORY, quantity: usage.imageInputTokens },
    { category: IMAGE_OUTPUT_CATEGORY, quantity: usage.imageOutputTokens },
  ].filter((row) => {
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
        provider: USAGE_PROVIDER,
        category: row.category,
        quantity: row.quantity,
      };
    }),
  );
  await processOrgUsageEvents(org.orgId);

  return NextResponse.json({
    id: fileId,
    filename,
    contentType,
    size: imageBytes.byteLength,
    url,
    creditsCharged: calculateCredits(usage, pricing),
    model: MODEL,
    imageSize: responseBody.size ?? options.size,
    quality: responseBody.quality ?? options.quality,
    background: responseBody.background ?? options.background,
    outputFormat,
    ...outputCompressionField(options),
    moderation: options.moderation,
    revisedPrompt: image.revised_prompt,
    usage,
  });
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
