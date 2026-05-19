import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";

import { buildArtifactKey, buildFileUrl } from "../../lib/file-url";
import { env } from "../../lib/env";
import { db$, writeDb$ } from "../external/db";
import { putS3Object } from "../external/s3";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import {
  builtInGenerationUsageIdempotencyKey,
  type BuiltInGenerationUsageIdempotency,
} from "./built-in-generation-usage-idempotency";

export const VIDEO_IO_MODEL = "fal-ai/veo3.1/fast";
export const FAL_VIDEO_QUEUE_URL = `https://queue.fal.run/${VIDEO_IO_MODEL}`;

const VIDEO_IO_MAX_PROMPT_LENGTH = 32_000;

const USAGE_KIND = "video";
const VIDEO_AUDIO_CATEGORY = "output_video_seconds.audio";
const VIDEO_SILENT_CATEGORY = "output_video_seconds.silent";
const VIDEO_AUDIO_4K_CATEGORY = "output_video_seconds.audio.4k";
const VIDEO_SILENT_4K_CATEGORY = "output_video_seconds.silent.4k";
const VIDEO_TOKEN_CATEGORY = "output_video_tokens";
const VIDEO_PRICING_CATEGORIES = [
  VIDEO_AUDIO_CATEGORY,
  VIDEO_SILENT_CATEGORY,
  VIDEO_AUDIO_4K_CATEGORY,
  VIDEO_SILENT_4K_CATEGORY,
  VIDEO_TOKEN_CATEGORY,
] as const;

const STANDARD_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const SEEDANCE_VIDEO_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
const VIDEO_ASPECT_RATIOS = SEEDANCE_VIDEO_ASPECT_RATIOS;
const VEO_VIDEO_DURATIONS = ["4s", "6s", "8s"] as const;
const KLING_VIDEO_DURATIONS = [
  "3s",
  "4s",
  "5s",
  "6s",
  "7s",
  "8s",
  "9s",
  "10s",
  "11s",
  "12s",
  "13s",
  "14s",
  "15s",
] as const;
const SEEDANCE_VIDEO_DURATIONS = [
  "4s",
  "5s",
  "6s",
  "7s",
  "8s",
  "9s",
  "10s",
  "11s",
  "12s",
  "13s",
  "14s",
  "15s",
] as const;
const VIDEO_DURATIONS = [...KLING_VIDEO_DURATIONS] as const;
const VEO_VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
const SEEDANCE_VIDEO_RESOLUTIONS = ["480p", "720p"] as const;
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
const VIDEO_SAFETY_TOLERANCES = ["1", "2", "3", "4", "5", "6"] as const;
const SEEDANCE_DIMENSIONS = {
  "480p": {
    "21:9": { width: 992, height: 432 },
    "16:9": { width: 864, height: 496 },
    "4:3": { width: 752, height: 560 },
    "1:1": { width: 640, height: 640 },
    "3:4": { width: 560, height: 752 },
    "9:16": { width: 496, height: 864 },
  },
  "720p": {
    "21:9": { width: 1470, height: 630 },
    "16:9": { width: 1280, height: 720 },
    "4:3": { width: 1112, height: 834 },
    "1:1": { width: 960, height: 960 },
    "3:4": { width: 834, height: 1112 },
    "9:16": { width: 720, height: 1280 },
  },
} as const satisfies Record<
  (typeof SEEDANCE_VIDEO_RESOLUTIONS)[number],
  Record<
    (typeof SEEDANCE_VIDEO_ASPECT_RATIOS)[number],
    { readonly width: number; readonly height: number }
  >
>;

const SEEDANCE_RESOLUTION_VALUES: readonly string[] =
  SEEDANCE_VIDEO_RESOLUTIONS;
const SEEDANCE_ASPECT_RATIO_VALUES: readonly string[] =
  SEEDANCE_VIDEO_ASPECT_RATIOS;

type SeedanceResolution = (typeof SEEDANCE_VIDEO_RESOLUTIONS)[number];
type SeedanceAspectRatio = (typeof SEEDANCE_VIDEO_ASPECT_RATIOS)[number];

function isSeedanceResolution(value: string): value is SeedanceResolution {
  return SEEDANCE_RESOLUTION_VALUES.includes(value);
}

function isSeedanceAspectRatio(value: string): value is SeedanceAspectRatio {
  return SEEDANCE_ASPECT_RATIO_VALUES.includes(value);
}

function seedanceDimensions(
  resolution: string,
  aspectRatio: string,
): { readonly width: number; readonly height: number } {
  if (
    !isSeedanceResolution(resolution) ||
    !isSeedanceAspectRatio(aspectRatio)
  ) {
    throw new Error("Unsupported Seedance video dimensions");
  }
  return SEEDANCE_DIMENSIONS[resolution][aspectRatio];
}

const VIDEO_MODEL_ALIASES = {
  "veo3.1-fast": "fal-ai/veo3.1/fast",
  "veo3.1": "fal-ai/veo3.1",
  "kling-o3-standard": "fal-ai/kling-video/o3/standard/text-to-video",
  "kling-v3-4k": "fal-ai/kling-video/v3/4k/text-to-video",
  "seedance2.0": "bytedance/seedance-2.0/text-to-video",
  "seedance2.0-fast": "bytedance/seedance-2.0/fast/text-to-video",
} as const;

const VIDEO_MODEL_CONFIGS = {
  "fal-ai/veo3.1/fast": {
    alias: "veo3.1-fast",
    requestFormat: "veo",
    aspectRatios: STANDARD_VIDEO_ASPECT_RATIOS,
    durations: VEO_VIDEO_DURATIONS,
    resolutions: VEO_VIDEO_RESOLUTIONS,
    defaultResolution: "720p",
    supportsNegativePrompt: true,
    supportsSeed: true,
    supportsAutoFix: true,
    supportsSafetyTolerance: true,
  },
  "fal-ai/veo3.1": {
    alias: "veo3.1",
    requestFormat: "veo",
    aspectRatios: STANDARD_VIDEO_ASPECT_RATIOS,
    durations: VEO_VIDEO_DURATIONS,
    resolutions: VEO_VIDEO_RESOLUTIONS,
    defaultResolution: "720p",
    supportsNegativePrompt: true,
    supportsSeed: true,
    supportsAutoFix: true,
    supportsSafetyTolerance: true,
  },
  "fal-ai/kling-video/o3/standard/text-to-video": {
    alias: "kling-o3-standard",
    requestFormat: "kling",
    aspectRatios: STANDARD_VIDEO_ASPECT_RATIOS,
    durations: KLING_VIDEO_DURATIONS,
    resolutions: ["1080p"],
    defaultResolution: "1080p",
    supportsNegativePrompt: false,
    supportsSeed: false,
    supportsAutoFix: false,
    supportsSafetyTolerance: false,
  },
  "fal-ai/kling-video/v3/4k/text-to-video": {
    alias: "kling-v3-4k",
    requestFormat: "kling",
    aspectRatios: STANDARD_VIDEO_ASPECT_RATIOS,
    durations: KLING_VIDEO_DURATIONS,
    resolutions: ["4k"],
    defaultResolution: "4k",
    supportsNegativePrompt: true,
    supportsSeed: false,
    supportsAutoFix: false,
    supportsSafetyTolerance: false,
  },
  "bytedance/seedance-2.0/text-to-video": {
    alias: "seedance2.0",
    requestFormat: "seedance",
    aspectRatios: SEEDANCE_VIDEO_ASPECT_RATIOS,
    durations: SEEDANCE_VIDEO_DURATIONS,
    resolutions: SEEDANCE_VIDEO_RESOLUTIONS,
    defaultResolution: "720p",
    supportsNegativePrompt: false,
    supportsSeed: true,
    supportsAutoFix: false,
    supportsSafetyTolerance: false,
  },
  "bytedance/seedance-2.0/fast/text-to-video": {
    alias: "seedance2.0-fast",
    requestFormat: "seedance",
    aspectRatios: SEEDANCE_VIDEO_ASPECT_RATIOS,
    durations: SEEDANCE_VIDEO_DURATIONS,
    resolutions: SEEDANCE_VIDEO_RESOLUTIONS,
    defaultResolution: "720p",
    supportsNegativePrompt: false,
    supportsSeed: true,
    supportsAutoFix: false,
    supportsSafetyTolerance: false,
  },
} as const;

const VIDEO_MODELS = Object.keys(VIDEO_MODEL_CONFIGS) as VideoModel[];

type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
type VideoDuration = (typeof VIDEO_DURATIONS)[number];
type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
type VideoSafetyTolerance = (typeof VIDEO_SAFETY_TOLERANCES)[number];
type VideoPricingCategory = (typeof VIDEO_PRICING_CATEGORIES)[number];
type VideoModel = keyof typeof VIDEO_MODEL_CONFIGS;

type ErrorStatus = 400 | 402 | 500 | 502 | 503 | 504;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

type VideoErrorResponse = {
  readonly status: ErrorStatus;
  readonly body: ErrorBody;
};

export interface VideoPricingRow {
  readonly provider: VideoModel;
  readonly category: VideoPricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

type VideoPricing = ReadonlyMap<string, VideoPricingRow>;

export interface VideoOptions {
  readonly model: VideoModel;
  readonly prompt: string;
  readonly aspectRatio: VideoAspectRatio;
  readonly duration: VideoDuration;
  readonly durationSeconds: number;
  readonly resolution: VideoResolution;
  readonly generateAudio: boolean;
  readonly negativePrompt: string | undefined;
  readonly seed: number | undefined;
  readonly autoFix: boolean;
  readonly safetyTolerance: VideoSafetyTolerance;
}

interface FalQueueHandle {
  readonly requestId: string | undefined;
  readonly statusUrl: string;
  readonly responseUrl: string;
}

interface FalFile {
  readonly url: string;
  readonly contentType: string | undefined;
}

interface FalVideoResult {
  readonly requestId: string | undefined;
  readonly sourceUrl: string;
  readonly falContentType: string | undefined;
}

interface ParsedVideoGeneration {
  readonly model: VideoModel;
  readonly videoBytes: Buffer;
  readonly contentType: string;
  readonly sourceUrl: string;
  readonly requestId: string | undefined;
  readonly aspectRatio: VideoAspectRatio;
  readonly duration: VideoDuration;
  readonly durationSeconds: number;
  readonly resolution: VideoResolution;
  readonly generateAudio: boolean;
  readonly negativePrompt: string | undefined;
  readonly seed: number | undefined;
  readonly autoFix: boolean;
  readonly safetyTolerance: VideoSafetyTolerance;
}

interface RecordedVideo {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly durationSeconds: number;
  readonly creditsCharged: number;
  readonly model: VideoModel;
  readonly aspectRatio: VideoAspectRatio;
  readonly duration: VideoDuration;
  readonly resolution: VideoResolution;
  readonly generateAudio: boolean;
  readonly sourceUrl: string;
  readonly requestId: string | undefined;
}

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string, code = "BAD_REQUEST") {
  return { status: 400 as const, body: errorBody(message, code) };
}

function videoInternalError(message: string) {
  return {
    status: 500 as const,
    body: errorBody(message, "INTERNAL_SERVER_ERROR"),
  };
}

function badGateway(message: string, code: string) {
  return { status: 502 as const, body: errorBody(message, code) };
}

export function videoServiceUnavailable(message: string, code: string) {
  return { status: 503 as const, body: errorBody(message, code) };
}

export function videoInsufficientCredits() {
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

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
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

function normalizeVideoModel(value: string): VideoModel | null {
  if (value in VIDEO_MODEL_CONFIGS) {
    return value as VideoModel;
  }
  if (value in VIDEO_MODEL_ALIASES) {
    return VIDEO_MODEL_ALIASES[value as keyof typeof VIDEO_MODEL_ALIASES];
  }
  return null;
}

function videoModelList(): string {
  return Object.keys(VIDEO_MODEL_ALIASES).join(", ");
}

function parseDurationSeconds(duration: VideoDuration): number {
  return Number(duration.replace("s", ""));
}

export function parseVideoOptions(
  body: unknown,
): VideoOptions | VideoErrorResponse {
  if (!isRecord(body)) {
    return badRequest("Invalid JSON body");
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    return badRequest("prompt is required");
  }
  if (prompt.length > VIDEO_IO_MAX_PROMPT_LENGTH) {
    return badRequest(
      `prompt exceeds ${VIDEO_IO_MAX_PROMPT_LENGTH} characters`,
    );
  }

  const rawModel = readString(body, "model", VIDEO_IO_MODEL);
  const model = normalizeVideoModel(rawModel);
  if (!model) {
    return badRequest(
      `Unsupported video model: ${rawModel}. Available models: ${videoModelList()}`,
    );
  }
  const modelConfig = VIDEO_MODEL_CONFIGS[model];

  const aspectRatio = readString(body, "aspectRatio", "16:9");
  if (!includesString(VIDEO_ASPECT_RATIOS, aspectRatio)) {
    return badRequest(`Unsupported video aspect ratio: ${aspectRatio}`);
  }
  if (!hasString(modelConfig.aspectRatios, aspectRatio)) {
    return badRequest(
      `Unsupported video aspect ratio for ${modelConfig.alias}: ${aspectRatio}`,
    );
  }

  const duration = readString(body, "duration", "8s");
  if (!includesString(VIDEO_DURATIONS, duration)) {
    return badRequest(`Unsupported video duration: ${duration}`);
  }
  if (!hasString(modelConfig.durations, duration)) {
    return badRequest(
      `Unsupported video duration for ${modelConfig.alias}: ${duration}`,
    );
  }

  const resolution = readString(
    body,
    "resolution",
    modelConfig.defaultResolution,
  );
  if (!includesString(VIDEO_RESOLUTIONS, resolution)) {
    return badRequest(`Unsupported video resolution: ${resolution}`);
  }
  if (!hasString(modelConfig.resolutions, resolution)) {
    return badRequest(
      `Unsupported video resolution for ${modelConfig.alias}: ${resolution}`,
    );
  }

  const safetyTolerance = readString(body, "safetyTolerance", "4");
  if (!includesString(VIDEO_SAFETY_TOLERANCES, safetyTolerance)) {
    return badRequest(`Unsupported safety tolerance: ${safetyTolerance}`);
  }

  const seed = typeof body.seed === "number" ? body.seed : undefined;
  if (
    seed !== undefined &&
    (!Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed))
  ) {
    return badRequest("seed must be a non-negative safe integer");
  }

  const generateAudio = readBoolean(
    body,
    "generateAudio",
    readBoolean(body, "generate_audio", true),
  );
  const autoFix = readBoolean(
    body,
    "autoFix",
    readBoolean(body, "auto_fix", true),
  );

  return {
    model,
    prompt,
    aspectRatio,
    duration,
    durationSeconds: parseDurationSeconds(duration),
    resolution,
    generateAudio,
    negativePrompt:
      readOptionalString(body, "negativePrompt") ??
      readOptionalString(body, "negative_prompt"),
    seed,
    autoFix,
    safetyTolerance,
  };
}

function mapPricingRows(
  rows: readonly {
    readonly provider: string;
    readonly category: string;
    readonly unitPrice: number;
    readonly unitSize: number;
  }[],
): VideoPricing {
  const pricing = new Map<string, VideoPricingRow>();
  for (const row of rows) {
    const model = normalizeVideoModel(row.provider);
    if (model && includesString(VIDEO_PRICING_CATEGORIES, row.category)) {
      pricing.set(videoPricingKey(model, row.category), {
        provider: model,
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }
  return pricing;
}

export function videoPricingKey(
  model: VideoModel,
  category: VideoPricingCategory,
): string {
  return `${model}:${category}`;
}

export function videoPricingCategoryForOptions(
  options: Pick<VideoOptions, "generateAudio" | "model" | "resolution">,
): VideoPricingCategory {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  if (config.requestFormat === "seedance") {
    return VIDEO_TOKEN_CATEGORY;
  }

  const resolution =
    config.requestFormat === "kling"
      ? config.defaultResolution
      : options.resolution;
  if (resolution === "4k") {
    return options.generateAudio
      ? VIDEO_AUDIO_4K_CATEGORY
      : VIDEO_SILENT_4K_CATEGORY;
  }
  return options.generateAudio ? VIDEO_AUDIO_CATEGORY : VIDEO_SILENT_CATEGORY;
}

export const videoPricing$: Computed<Promise<VideoPricing>> = computed(
  async (get): Promise<VideoPricing> => {
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
          inArray(usagePricing.provider, [...VIDEO_MODELS]),
          inArray(usagePricing.category, [...VIDEO_PRICING_CATEGORIES]),
        ),
      );

    return mapPricingRows(rows);
  },
);

export const checkVideoCredits$ = command(
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

function falHeaders(falKey: string): Record<string, string> {
  return {
    Authorization: `Key ${falKey}`,
    "Content-Type": "application/json",
  };
}

function parseFalQueueHandle(value: unknown): FalQueueHandle | null {
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

function falVideoQueueUrl(model: VideoModel): string {
  return `https://queue.fal.run/${model}`;
}

function falVideoInput(options: VideoOptions): Record<string, unknown> {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  if (config.requestFormat === "seedance") {
    return {
      prompt: options.prompt,
      aspect_ratio: options.aspectRatio,
      duration: String(options.durationSeconds),
      resolution: options.resolution,
      generate_audio: options.generateAudio,
      ...(config.supportsSeed && options.seed !== undefined
        ? { seed: options.seed }
        : {}),
    };
  }

  if (config.requestFormat === "kling") {
    return {
      prompt: options.prompt,
      aspect_ratio: options.aspectRatio,
      duration: String(options.durationSeconds),
      generate_audio: options.generateAudio,
      ...(config.supportsNegativePrompt && options.negativePrompt
        ? { negative_prompt: options.negativePrompt }
        : {}),
    };
  }

  return {
    prompt: options.prompt,
    aspect_ratio: options.aspectRatio,
    duration: options.duration,
    resolution: options.resolution,
    generate_audio: options.generateAudio,
    ...(config.supportsAutoFix ? { auto_fix: options.autoFix } : {}),
    ...(config.supportsSafetyTolerance
      ? { safety_tolerance: options.safetyTolerance }
      : {}),
    ...(config.supportsNegativePrompt && options.negativePrompt
      ? { negative_prompt: options.negativePrompt }
      : {}),
    ...(config.supportsSeed && options.seed !== undefined
      ? { seed: options.seed }
      : {}),
  };
}

export async function submitFalVideoGeneration(
  options: VideoOptions,
  falKey: string,
  signal: AbortSignal,
  webhookUrl?: string,
): Promise<FalQueueHandle | VideoErrorResponse> {
  const queueUrl = new URL(falVideoQueueUrl(options.model));
  if (webhookUrl) {
    queueUrl.searchParams.set("fal_webhook", webhookUrl);
  }
  const response = await fetch(queueUrl, {
    method: "POST",
    headers: falHeaders(falKey),
    body: JSON.stringify(falVideoInput(options)),
    signal,
  });

  if (!response.ok) {
    return videoInternalError("Video generation failed");
  }

  const body: unknown = await response.json();
  const handle = parseFalQueueHandle(body);
  if (!handle) {
    return badGateway("Fal returned no queue handle", "NO_QUEUE_HANDLE");
  }
  return handle;
}

function parseFalFile(value: unknown): FalFile | null {
  if (!isRecord(value) || typeof value.url !== "string") {
    return null;
  }
  return {
    url: value.url,
    contentType:
      typeof value.content_type === "string" ? value.content_type : undefined,
  };
}

export function parseFalVideoResult(
  value: unknown,
  requestId: string | undefined,
): FalVideoResult | VideoErrorResponse {
  if (!isRecord(value)) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  const video = parseFalFile(value.video);
  if (!video) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  return {
    requestId,
    sourceUrl: video.url,
    falContentType: video.contentType,
  };
}

function normalizeVideoContentType(
  value: string | null | undefined,
): string | null {
  const contentType = value?.split(";")[0]?.trim().toLowerCase();
  if (
    contentType === "video/mp4" ||
    contentType === "video/webm" ||
    contentType === "video/quicktime"
  ) {
    return contentType;
  }
  return null;
}

export async function downloadFalVideo(
  result: FalVideoResult,
  options: VideoOptions,
  signal: AbortSignal,
): Promise<ParsedVideoGeneration | VideoErrorResponse> {
  const response = await fetch(result.sourceUrl, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download generated video",
      "VIDEO_DOWNLOAD_FAILED",
    );
  }

  const videoBytes = Buffer.from(await response.arrayBuffer());
  if (videoBytes.byteLength === 0) {
    return badGateway("Model returned empty video", "NO_VIDEO_RETURNED");
  }

  const contentType =
    normalizeVideoContentType(result.falContentType) ??
    normalizeVideoContentType(response.headers.get("content-type")) ??
    "video/mp4";

  return {
    model: options.model,
    videoBytes,
    contentType,
    sourceUrl: result.sourceUrl,
    requestId: result.requestId,
    aspectRatio: options.aspectRatio,
    duration: options.duration,
    durationSeconds: options.durationSeconds,
    resolution: options.resolution,
    generateAudio: options.generateAudio,
    negativePrompt: options.negativePrompt,
    seed: options.seed,
    autoFix: options.autoFix,
    safetyTolerance: options.safetyTolerance,
  };
}

function extensionForContentType(contentType: string): string {
  if (contentType === "video/webm") {
    return "webm";
  }
  if (contentType === "video/quicktime") {
    return "mov";
  }
  return "mp4";
}

function seedanceOutputTokens(
  options: Pick<VideoOptions, "aspectRatio" | "durationSeconds" | "resolution">,
): number {
  const dimensions = seedanceDimensions(
    options.resolution,
    options.aspectRatio,
  );
  return Math.ceil(
    (dimensions.width * dimensions.height * options.durationSeconds * 24) /
      1024,
  );
}

function videoBillingQuantityForOptions(
  options: Pick<
    VideoOptions,
    "aspectRatio" | "durationSeconds" | "model" | "resolution"
  >,
): number {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  if (config.requestFormat === "seedance") {
    return seedanceOutputTokens(options);
  }
  return options.durationSeconds;
}

function estimateVideoCredits(
  billingQuantity: number,
  pricing: VideoPricingRow,
): number {
  return Math.ceil((billingQuantity * pricing.unitPrice) / pricing.unitSize);
}

export const recordGeneratedVideo$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly pricing: VideoPricingRow;
      readonly generation: ParsedVideoGeneration;
      readonly usageIdempotency: BuiltInGenerationUsageIdempotency;
    },
    signal: AbortSignal,
  ): Promise<RecordedVideo> => {
    const writeDb = set(writeDb$);
    const fileId = randomUUID();
    const filename = `video-${fileId.slice(0, 8)}.${extensionForContentType(
      params.generation.contentType,
    )}`;
    const s3Key = buildArtifactKey(params.userId, fileId, filename);
    await get(
      putS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        s3Key,
        params.generation.videoBytes,
        params.generation.contentType,
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
        contentType: params.generation.contentType,
        sizeBytes: params.generation.videoBytes.byteLength,
        url,
        s3Key,
        metadata: {
          generatedBy: "zero-official-video",
          model: params.generation.model,
          sourceUrl: params.generation.sourceUrl,
          requestId: params.generation.requestId,
          aspectRatio: params.generation.aspectRatio,
          duration: params.generation.duration,
          durationSeconds: params.generation.durationSeconds,
          resolution: params.generation.resolution,
          generateAudio: params.generation.generateAudio,
          negativePrompt: params.generation.negativePrompt,
          seed: params.generation.seed,
          autoFix: params.generation.autoFix,
          safetyTolerance: params.generation.safetyTolerance,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    await writeDb
      .insert(usageEvent)
      .values({
        runId: params.runId ?? null,
        idempotencyKey: builtInGenerationUsageIdempotencyKey({
          ...params.usageIdempotency,
          category: params.pricing.category,
        }),
        orgId: params.orgId,
        userId: params.userId,
        kind: USAGE_KIND,
        provider: params.generation.model,
        category: params.pricing.category,
        quantity: videoBillingQuantityForOptions(params.generation),
      })
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    return {
      id: fileId,
      filename,
      contentType: params.generation.contentType,
      size: params.generation.videoBytes.byteLength,
      url,
      durationSeconds: params.generation.durationSeconds,
      creditsCharged: estimateVideoCredits(
        videoBillingQuantityForOptions(params.generation),
        params.pricing,
      ),
      model: params.generation.model,
      aspectRatio: params.generation.aspectRatio,
      duration: params.generation.duration,
      resolution: params.generation.resolution,
      generateAudio: params.generation.generateAudio,
      sourceUrl: params.generation.sourceUrl,
      requestId: params.generation.requestId,
    };
  },
);
