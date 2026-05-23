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

export const VIDEO_IO_MODEL = "dreamina-seedance-2-0-fast-260128";
export const BYTEPLUS_VIDEO_TASKS_URL =
  "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

const VIDEO_IO_MAX_PROMPT_LENGTH = 32_000;

const USAGE_KIND = "video";
const VIDEO_AUDIO_CATEGORY = "output_video_seconds.audio";
const VIDEO_SILENT_CATEGORY = "output_video_seconds.silent";
const VIDEO_AUDIO_4K_CATEGORY = "output_video_seconds.audio.4k";
const VIDEO_SILENT_4K_CATEGORY = "output_video_seconds.silent.4k";
const VIDEO_TOKEN_CATEGORY = "output_video_tokens";
const VIDEO_TOKEN_480_720_NO_VIDEO_CATEGORY =
  "output_video_tokens.480p_720p.no_video";
const VIDEO_TOKEN_480_720_WITH_VIDEO_CATEGORY =
  "output_video_tokens.480p_720p.with_video";
const VIDEO_TOKEN_1080_NO_VIDEO_CATEGORY = "output_video_tokens.1080p.no_video";
const VIDEO_TOKEN_1080_WITH_VIDEO_CATEGORY =
  "output_video_tokens.1080p.with_video";
const VIDEO_TOKEN_AUDIO_CATEGORY = "output_video_tokens.audio";
const VIDEO_TOKEN_SILENT_CATEGORY = "output_video_tokens.silent";
const VIDEO_PRICING_CATEGORIES = [
  VIDEO_AUDIO_CATEGORY,
  VIDEO_SILENT_CATEGORY,
  VIDEO_AUDIO_4K_CATEGORY,
  VIDEO_SILENT_4K_CATEGORY,
  VIDEO_TOKEN_CATEGORY,
  VIDEO_TOKEN_480_720_NO_VIDEO_CATEGORY,
  VIDEO_TOKEN_480_720_WITH_VIDEO_CATEGORY,
  VIDEO_TOKEN_1080_NO_VIDEO_CATEGORY,
  VIDEO_TOKEN_1080_WITH_VIDEO_CATEGORY,
  VIDEO_TOKEN_AUDIO_CATEGORY,
  VIDEO_TOKEN_SILENT_CATEGORY,
] as const;

const VIDEO_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
const STANDARD_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const VIDEO_DURATIONS = [
  "2s",
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
const SEEDANCE_2_DURATIONS = [
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
const SEEDANCE_1_5_DURATIONS = [
  "4s",
  "5s",
  "6s",
  "7s",
  "8s",
  "9s",
  "10s",
  "11s",
  "12s",
] as const;
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const SEEDANCE_FAST_RESOLUTIONS = ["480p", "720p"] as const;
const VEO_VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
const KLING_4K_VIDEO_RESOLUTIONS = ["4k"] as const;

type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
type VideoDuration = (typeof VIDEO_DURATIONS)[number];
type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
type SeedanceResolution = (typeof SEEDANCE_RESOLUTIONS)[number];
type VideoPricingCategory = (typeof VIDEO_PRICING_CATEGORIES)[number];
type VideoProvider = "byteplus" | "fal";
type VideoModelFamily = "seedance-2" | "seedance-1-5";
type FalRequestFormat = "veo" | "kling";
type VideoDimensions = {
  readonly width: number;
  readonly height: number;
};
type DimensionTable = Record<
  SeedanceResolution,
  Record<VideoAspectRatio, VideoDimensions>
>;

interface BaseVideoModelConfig {
  readonly alias: string;
  readonly aspectRatios: readonly VideoAspectRatio[];
  readonly durations: readonly VideoDuration[];
  readonly resolutions: readonly VideoResolution[];
  readonly defaultResolution: VideoResolution;
  readonly supportsGenerateAudio: boolean;
  readonly supportsSeed: boolean;
  readonly supportsNegativePrompt: boolean;
  readonly supportsAutoFix: boolean;
  readonly supportsSafetyTolerance: boolean;
  readonly supportsReferenceImage: boolean;
  readonly supportsReferenceVideo: boolean;
  readonly supportsReferenceAudio: boolean;
  readonly supportsFirstFrame: boolean;
  readonly supportsLastFrame: boolean;
  readonly public: boolean;
}

interface BytePlusVideoModelConfig extends BaseVideoModelConfig {
  readonly provider: "byteplus";
  readonly family: VideoModelFamily;
}

interface FalVideoModelConfig extends BaseVideoModelConfig {
  readonly provider: "fal";
  readonly requestFormat: FalRequestFormat;
}

type VideoModelConfig = BytePlusVideoModelConfig | FalVideoModelConfig;

const SEEDANCE_2_DIMENSIONS = {
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
  "1080p": {
    "21:9": { width: 2206, height: 946 },
    "16:9": { width: 1920, height: 1080 },
    "4:3": { width: 1664, height: 1248 },
    "1:1": { width: 1440, height: 1440 },
    "3:4": { width: 1248, height: 1664 },
    "9:16": { width: 1080, height: 1920 },
  },
} as const satisfies DimensionTable;

const VIDEO_MODEL_CONFIGS = {
  "dreamina-seedance-2-0-260128": {
    provider: "byteplus",
    alias: "dreamina-seedance-2.0",
    family: "seedance-2",
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: SEEDANCE_2_DURATIONS,
    resolutions: SEEDANCE_RESOLUTIONS,
    defaultResolution: "720p",
    supportsGenerateAudio: true,
    supportsSeed: true,
    supportsNegativePrompt: false,
    supportsAutoFix: false,
    supportsSafetyTolerance: false,
    supportsReferenceImage: true,
    supportsReferenceVideo: true,
    supportsReferenceAudio: true,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    public: true,
  },
  "dreamina-seedance-2-0-fast-260128": {
    provider: "byteplus",
    alias: "dreamina-seedance-2.0-fast",
    family: "seedance-2",
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: SEEDANCE_2_DURATIONS,
    resolutions: SEEDANCE_FAST_RESOLUTIONS,
    defaultResolution: "720p",
    supportsGenerateAudio: true,
    supportsSeed: true,
    supportsNegativePrompt: false,
    supportsAutoFix: false,
    supportsSafetyTolerance: false,
    supportsReferenceImage: true,
    supportsReferenceVideo: true,
    supportsReferenceAudio: true,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    public: true,
  },
  "seedance-1-5-pro-251215": {
    provider: "byteplus",
    alias: "seedance-1.5-pro",
    family: "seedance-1-5",
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: SEEDANCE_1_5_DURATIONS,
    resolutions: SEEDANCE_RESOLUTIONS,
    defaultResolution: "720p",
    supportsGenerateAudio: true,
    supportsSeed: true,
    supportsNegativePrompt: false,
    supportsAutoFix: false,
    supportsSafetyTolerance: false,
    supportsReferenceImage: true,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    public: true,
  },
  "fal-ai/veo3.1/fast": {
    provider: "fal",
    alias: "veo3.1-fast",
    requestFormat: "veo",
    aspectRatios: STANDARD_VIDEO_ASPECT_RATIOS,
    durations: VEO_VIDEO_DURATIONS,
    resolutions: VEO_VIDEO_RESOLUTIONS,
    defaultResolution: "720p",
    supportsGenerateAudio: true,
    supportsSeed: true,
    supportsNegativePrompt: true,
    supportsAutoFix: true,
    supportsSafetyTolerance: true,
    supportsReferenceImage: false,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
    supportsFirstFrame: false,
    supportsLastFrame: false,
    public: true,
  },
  "fal-ai/kling-video/v3/4k/text-to-video": {
    provider: "fal",
    alias: "kling-v3-4k",
    requestFormat: "kling",
    aspectRatios: STANDARD_VIDEO_ASPECT_RATIOS,
    durations: KLING_VIDEO_DURATIONS,
    resolutions: KLING_4K_VIDEO_RESOLUTIONS,
    defaultResolution: "4k",
    supportsGenerateAudio: true,
    supportsSeed: false,
    supportsNegativePrompt: true,
    supportsAutoFix: false,
    supportsSafetyTolerance: false,
    supportsReferenceImage: false,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
    supportsFirstFrame: false,
    supportsLastFrame: false,
    public: true,
  },
} as const satisfies Record<string, VideoModelConfig>;

type VideoModel = keyof typeof VIDEO_MODEL_CONFIGS;

const VIDEO_MODELS = Object.keys(VIDEO_MODEL_CONFIGS) as VideoModel[];

const VIDEO_MODEL_ALIASES = {
  "dreamina-seedance-2.0": "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2-0": "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2.0-fast": "dreamina-seedance-2-0-fast-260128",
  "dreamina-seedance-2-0-fast": "dreamina-seedance-2-0-fast-260128",
  "seedance-1.5-pro": "seedance-1-5-pro-251215",
  "seedance-1-5-pro": "seedance-1-5-pro-251215",
  "seedance2.0": "dreamina-seedance-2-0-260128",
  "seedance2.0-fast": "dreamina-seedance-2-0-fast-260128",
  "veo3.1-fast": "fal-ai/veo3.1/fast",
  "kling-v3-4k": "fal-ai/kling-video/v3/4k/text-to-video",
} as const satisfies Readonly<Record<string, VideoModel>>;

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
  readonly safetyTolerance: string;
  readonly referenceImageUrls: readonly string[];
  readonly inputVideoUrls: readonly string[];
  readonly referenceAudioUrls: readonly string[];
  readonly firstFrameImageUrl: string | undefined;
  readonly lastFrameImageUrl: string | undefined;
}

interface BytePlusTaskHandle {
  readonly taskId: string;
  readonly status: string | undefined;
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

interface BytePlusVideoResult {
  readonly requestId: string | undefined;
  readonly sourceUrl: string;
  readonly bytePlusContentType: string | undefined;
  readonly completionTokens: number | undefined;
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
  readonly safetyTolerance: string;
  readonly referenceImageUrls: readonly string[];
  readonly inputVideoUrls: readonly string[];
  readonly referenceAudioUrls: readonly string[];
  readonly firstFrameImageUrl: string | undefined;
  readonly lastFrameImageUrl: string | undefined;
  readonly billingQuantity: number;
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
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

type BytePlusContent =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image_url";
      readonly image_url: { readonly url: string };
      readonly role?: "first_frame" | "last_frame" | "reference_image";
    }
  | {
      readonly type: "video_url";
      readonly video_url: { readonly url: string };
      readonly role: "reference_video";
    }
  | {
      readonly type: "audio_url";
      readonly audio_url: { readonly url: string };
      readonly role: "reference_audio";
    };

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
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function readOptionalStringFromKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readOptionalString(body, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readStringArray(
  body: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = body[key];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => {
        return typeof entry === "string";
      })
      .map((entry) => {
        return entry.trim();
      })
      .filter((entry) => {
        return entry.length > 0;
      });
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function readStringArrayFromKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
): readonly string[] {
  return [
    ...new Set(
      keys.flatMap((key) => {
        return readStringArray(body, key);
      }),
    ),
  ];
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

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      return entry !== undefined;
    }),
  );
}

function normalizeVideoModel(value: string): VideoModel | null {
  if (value in VIDEO_MODEL_CONFIGS) {
    return value as VideoModel;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized in VIDEO_MODEL_ALIASES) {
    return VIDEO_MODEL_ALIASES[normalized as keyof typeof VIDEO_MODEL_ALIASES];
  }
  return null;
}

function videoModelList(): string {
  return VIDEO_MODELS.filter((model) => {
    return VIDEO_MODEL_CONFIGS[model].public;
  })
    .map((model) => {
      return VIDEO_MODEL_CONFIGS[model].alias;
    })
    .join(", ");
}

export function videoProviderForModel(model: VideoModel): VideoProvider {
  return VIDEO_MODEL_CONFIGS[model].provider;
}

function parseDurationSeconds(duration: VideoDuration): number {
  return Number(duration.replace("s", ""));
}

function validateVideoReferences(
  modelConfig: VideoModelConfig,
  options: {
    readonly alias: string;
    readonly referenceImageUrls: readonly string[];
    readonly inputVideoUrls: readonly string[];
    readonly referenceAudioUrls: readonly string[];
    readonly firstFrameImageUrl: string | undefined;
    readonly lastFrameImageUrl: string | undefined;
  },
): VideoErrorResponse | null {
  if (
    options.referenceImageUrls.length > 0 &&
    !modelConfig.supportsReferenceImage
  ) {
    return badRequest(
      `Reference images are not supported for ${options.alias}`,
    );
  }
  if (
    options.inputVideoUrls.length > 0 &&
    !modelConfig.supportsReferenceVideo
  ) {
    return badRequest(
      `Reference videos are not supported for ${options.alias}`,
    );
  }
  if (
    options.referenceAudioUrls.length > 0 &&
    !modelConfig.supportsReferenceAudio
  ) {
    return badRequest(`Reference audio is not supported for ${options.alias}`);
  }
  if (options.firstFrameImageUrl && !modelConfig.supportsFirstFrame) {
    return badRequest(
      `First frame image is not supported for ${options.alias}`,
    );
  }
  if (options.lastFrameImageUrl && !modelConfig.supportsLastFrame) {
    return badRequest(`Last frame image is not supported for ${options.alias}`);
  }
  if (options.inputVideoUrls.length > 3) {
    return badRequest("reference video URLs cannot exceed 3 items");
  }
  if (options.referenceAudioUrls.length > 1) {
    return badRequest("reference audio URLs cannot exceed 1 item");
  }
  if (
    options.referenceAudioUrls.length > 0 &&
    options.referenceImageUrls.length === 0 &&
    options.inputVideoUrls.length === 0 &&
    !options.firstFrameImageUrl &&
    !options.lastFrameImageUrl
  ) {
    return badRequest(
      "reference audio requires at least one image or video reference",
    );
  }
  return null;
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

  const seed = typeof body.seed === "number" ? body.seed : undefined;
  if (
    seed !== undefined &&
    (!Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed))
  ) {
    return badRequest("seed must be a non-negative safe integer");
  }

  const referenceImageUrls = readStringArrayFromKeys(body, [
    "imageUrls",
    "image_urls",
    "referenceImageUrls",
    "reference_image_urls",
  ]);
  const inputVideoUrls = readStringArrayFromKeys(body, [
    "videoUrls",
    "video_urls",
    "inputVideoUrls",
    "input_video_urls",
    "referenceVideoUrls",
    "reference_video_urls",
  ]);
  const referenceAudioUrls = readStringArrayFromKeys(body, [
    "audioUrls",
    "audio_urls",
    "referenceAudioUrls",
    "reference_audio_urls",
  ]);
  const firstFrameImageUrl = readOptionalStringFromKeys(body, [
    "firstFrameImageUrl",
    "first_frame_image_url",
  ]);
  const lastFrameImageUrl = readOptionalStringFromKeys(body, [
    "lastFrameImageUrl",
    "last_frame_image_url",
  ]);

  const referenceError = validateVideoReferences(modelConfig, {
    alias: modelConfig.alias,
    referenceImageUrls,
    inputVideoUrls,
    referenceAudioUrls,
    firstFrameImageUrl,
    lastFrameImageUrl,
  });
  if (referenceError) {
    return referenceError;
  }

  const requestedGenerateAudio = readBoolean(
    body,
    "generateAudio",
    readBoolean(body, "generate_audio", true),
  );

  return {
    model,
    prompt,
    aspectRatio,
    duration,
    durationSeconds: parseDurationSeconds(duration),
    resolution,
    generateAudio: modelConfig.supportsGenerateAudio
      ? requestedGenerateAudio
      : false,
    negativePrompt:
      readOptionalString(body, "negativePrompt") ??
      readOptionalString(body, "negative_prompt"),
    seed,
    autoFix: readBoolean(body, "autoFix", readBoolean(body, "auto_fix", true)),
    safetyTolerance: readString(body, "safetyTolerance", "4"),
    referenceImageUrls,
    inputVideoUrls,
    referenceAudioUrls,
    firstFrameImageUrl,
    lastFrameImageUrl,
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
  options: Pick<
    VideoOptions,
    "generateAudio" | "inputVideoUrls" | "model" | "resolution"
  >,
): VideoPricingCategory {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  if (config.provider === "fal") {
    if (options.resolution === "4k") {
      return options.generateAudio
        ? VIDEO_AUDIO_4K_CATEGORY
        : VIDEO_SILENT_4K_CATEGORY;
    }
    return options.generateAudio ? VIDEO_AUDIO_CATEGORY : VIDEO_SILENT_CATEGORY;
  }
  if (config.family === "seedance-2") {
    const hasInputVideo = options.inputVideoUrls.length > 0;
    if (options.resolution === "1080p") {
      return hasInputVideo
        ? VIDEO_TOKEN_1080_WITH_VIDEO_CATEGORY
        : VIDEO_TOKEN_1080_NO_VIDEO_CATEGORY;
    }
    return hasInputVideo
      ? VIDEO_TOKEN_480_720_WITH_VIDEO_CATEGORY
      : VIDEO_TOKEN_480_720_NO_VIDEO_CATEGORY;
  }
  if (config.family === "seedance-1-5") {
    return options.generateAudio
      ? VIDEO_TOKEN_AUDIO_CATEGORY
      : VIDEO_TOKEN_SILENT_CATEGORY;
  }
  return VIDEO_TOKEN_CATEGORY;
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
  if (config.provider !== "fal") {
    throw new Error("Expected a Fal video model");
  }

  if (config.requestFormat === "kling") {
    return compactObject({
      prompt: options.prompt,
      aspect_ratio: options.aspectRatio,
      duration: String(options.durationSeconds),
      generate_audio: options.generateAudio,
      ...(config.supportsNegativePrompt && options.negativePrompt
        ? { negative_prompt: options.negativePrompt }
        : {}),
    });
  }

  return compactObject({
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
  });
}

export async function submitFalVideoGeneration(
  options: VideoOptions,
  falKey: string,
  signal: AbortSignal,
  webhookUrl: string,
): Promise<FalQueueHandle | VideoErrorResponse> {
  const queueUrl = new URL(falVideoQueueUrl(options.model));
  queueUrl.searchParams.set("fal_webhook", webhookUrl);
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

function bytePlusHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function parseBytePlusTaskHandle(value: unknown): BytePlusTaskHandle | null {
  if (!isRecord(value)) {
    return null;
  }
  const taskId =
    typeof value.id === "string"
      ? value.id
      : typeof value.task_id === "string"
        ? value.task_id
        : undefined;
  if (!taskId) {
    return null;
  }
  return {
    taskId,
    status: typeof value.status === "string" ? value.status : undefined,
  };
}

function bytePlusVideoContent(
  options: VideoOptions,
): readonly BytePlusContent[] {
  const content: BytePlusContent[] = [
    {
      type: "text",
      text: options.prompt,
    },
  ];
  const hasFirstAndLastFrame =
    Boolean(options.firstFrameImageUrl) && Boolean(options.lastFrameImageUrl);
  if (options.firstFrameImageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: options.firstFrameImageUrl },
      ...(hasFirstAndLastFrame ? { role: "first_frame" } : {}),
    });
  }
  if (options.lastFrameImageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: options.lastFrameImageUrl },
      role: "last_frame",
    });
  }
  for (const url of options.referenceImageUrls) {
    content.push({
      type: "image_url",
      image_url: { url },
      role: "reference_image",
    });
  }
  for (const url of options.inputVideoUrls) {
    content.push({
      type: "video_url",
      video_url: { url },
      role: "reference_video",
    });
  }
  for (const url of options.referenceAudioUrls) {
    content.push({
      type: "audio_url",
      audio_url: { url },
      role: "reference_audio",
    });
  }
  return content;
}

function bytePlusVideoInput(
  options: VideoOptions,
  webhookUrl: string,
): Record<string, unknown> {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  return compactObject({
    model: options.model,
    content: bytePlusVideoContent(options),
    callback_url: webhookUrl,
    resolution: options.resolution,
    ratio: options.aspectRatio,
    duration: options.durationSeconds,
    ...(config.supportsGenerateAudio
      ? { generate_audio: options.generateAudio }
      : {}),
    ...(config.supportsSeed && options.seed !== undefined
      ? { seed: options.seed }
      : {}),
  });
}

export async function submitBytePlusVideoGeneration(
  options: VideoOptions,
  apiKey: string,
  signal: AbortSignal,
  webhookUrl: string,
): Promise<BytePlusTaskHandle | VideoErrorResponse> {
  const response = await fetch(BYTEPLUS_VIDEO_TASKS_URL, {
    method: "POST",
    headers: bytePlusHeaders(apiKey),
    body: JSON.stringify(bytePlusVideoInput(options, webhookUrl)),
    signal,
  });

  if (!response.ok) {
    return videoInternalError("Video generation failed");
  }

  const body: unknown = await response.json();
  const handle = parseBytePlusTaskHandle(body);
  if (!handle) {
    return badGateway("BytePlus returned no task handle", "NO_TASK_HANDLE");
  }
  return handle;
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

function readVideoUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = readVideoUrl(entry);
      if (url) {
        return url;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const directUrl =
    typeof value.video_url === "string"
      ? value.video_url
      : typeof value.url === "string"
        ? value.url
        : undefined;
  if (directUrl) {
    return directUrl;
  }
  return (
    readVideoUrl(value.video_url) ??
    readVideoUrl(value.video) ??
    readVideoUrl(value.output) ??
    readVideoUrl(value.result) ??
    readVideoUrl(value.content)
  );
}

function readVideoContentType(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const contentType = readVideoContentType(entry);
      if (contentType) {
        return contentType;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const directType =
    typeof value.content_type === "string"
      ? value.content_type
      : typeof value.contentType === "string"
        ? value.contentType
        : undefined;
  if (directType) {
    return directType;
  }
  return (
    readVideoContentType(value.video_url) ??
    readVideoContentType(value.video) ??
    readVideoContentType(value.output) ??
    readVideoContentType(value.result) ??
    readVideoContentType(value.content)
  );
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.ceil(value);
}

function readCompletionTokens(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage = isRecord(value.usage) ? value.usage : undefined;
  return (
    readPositiveInteger(usage?.completion_tokens) ??
    readPositiveInteger(usage?.total_tokens) ??
    readPositiveInteger(value.completion_tokens)
  );
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
  const sourceUrl = video?.url ?? readVideoUrl(value.video);
  if (!sourceUrl) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  return {
    requestId,
    sourceUrl,
    falContentType: video?.contentType ?? readVideoContentType(value.video),
  };
}

export function parseBytePlusVideoResult(
  value: unknown,
): BytePlusVideoResult | VideoErrorResponse {
  if (!isRecord(value)) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  const sourceUrl =
    readVideoUrl(value.content) ??
    readVideoUrl(value.output) ??
    readVideoUrl(value.result) ??
    readVideoUrl(value);
  if (!sourceUrl) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  return {
    requestId:
      typeof value.id === "string"
        ? value.id
        : typeof value.task_id === "string"
          ? value.task_id
          : undefined,
    sourceUrl,
    bytePlusContentType: readVideoContentType(value),
    completionTokens: readCompletionTokens(value),
  };
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
    referenceImageUrls: options.referenceImageUrls,
    inputVideoUrls: options.inputVideoUrls,
    referenceAudioUrls: options.referenceAudioUrls,
    firstFrameImageUrl: options.firstFrameImageUrl,
    lastFrameImageUrl: options.lastFrameImageUrl,
    billingQuantity: videoBillingQuantityForOptions(options),
  };
}

export async function downloadBytePlusVideo(
  result: BytePlusVideoResult,
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
    normalizeVideoContentType(result.bytePlusContentType) ??
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
    referenceImageUrls: options.referenceImageUrls,
    inputVideoUrls: options.inputVideoUrls,
    referenceAudioUrls: options.referenceAudioUrls,
    firstFrameImageUrl: options.firstFrameImageUrl,
    lastFrameImageUrl: options.lastFrameImageUrl,
    billingQuantity:
      result.completionTokens ?? videoBillingQuantityForOptions(options),
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

function isSeedanceResolution(
  resolution: VideoResolution,
): resolution is SeedanceResolution {
  return includesString(SEEDANCE_RESOLUTIONS, resolution);
}

function seedanceDimensions(
  model: VideoModel,
  resolution: VideoResolution,
  aspectRatio: VideoAspectRatio,
): VideoDimensions {
  if (!isSeedanceResolution(resolution)) {
    throw new Error("Unsupported Seedance video resolution");
  }
  const config = VIDEO_MODEL_CONFIGS[model];
  if (config.provider !== "byteplus") {
    throw new Error("Expected a BytePlus video model");
  }
  return SEEDANCE_2_DIMENSIONS[resolution][aspectRatio];
}

function seedanceOutputTokens(
  options: Pick<
    VideoOptions,
    "aspectRatio" | "durationSeconds" | "model" | "resolution"
  >,
): number {
  const dimensions = seedanceDimensions(
    options.model,
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
  if (VIDEO_MODEL_CONFIGS[options.model].provider === "fal") {
    return options.durationSeconds;
  }
  return seedanceOutputTokens(options);
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
        metadata: compactObject({
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
          billingQuantity: params.generation.billingQuantity,
          referenceImageUrls:
            params.generation.referenceImageUrls.length > 0
              ? params.generation.referenceImageUrls
              : undefined,
          inputVideoUrls:
            params.generation.inputVideoUrls.length > 0
              ? params.generation.inputVideoUrls
              : undefined,
          referenceAudioUrls:
            params.generation.referenceAudioUrls.length > 0
              ? params.generation.referenceAudioUrls
              : undefined,
          firstFrameImageUrl: params.generation.firstFrameImageUrl,
          lastFrameImageUrl: params.generation.lastFrameImageUrl,
        }),
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
        quantity: params.generation.billingQuantity,
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
        params.generation.billingQuantity,
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
