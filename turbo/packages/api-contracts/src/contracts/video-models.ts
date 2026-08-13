/**
 * Value domains for built-in text-to-video generation.
 *
 * These live here so request and chat contracts can validate generation
 * parameters directly. Which subset each model accepts, along with the rest of
 * the per-model capabilities, lives in `@vm0/core/video-model-catalog`, which
 * depends on this package.
 */
export const VIDEO_MODEL_IDS = [
  "dreamina-seedance-2-5-260628",
  "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2-0-fast-260128",
  "dreamina-seedance-2-0-mini-260615",
  "seedance-1-5-pro-251215",
  "fal-ai/veo3.1/fast",
  "fal-ai/kling-video/v3/4k/text-to-video",
  "MiniMax-H3",
] as const;

export type VideoModelId = (typeof VIDEO_MODEL_IDS)[number];

const VIDEO_MODEL_ID_SET: ReadonlySet<string> = new Set(VIDEO_MODEL_IDS);

/**
 * Persisted video model ids are projected without being re-validated against
 * the catalog, so a stored id can outlive the model it names.
 */
export function isVideoModelId(
  model: string | null | undefined,
): model is VideoModelId {
  return typeof model === "string" && VIDEO_MODEL_ID_SET.has(model);
}

export const VIDEO_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;

export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

export const VIDEO_DURATIONS = [
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
  "16s",
  "17s",
  "18s",
  "19s",
  "20s",
  "21s",
  "22s",
  "23s",
  "24s",
  "25s",
  "26s",
  "27s",
  "28s",
  "29s",
  "30s",
] as const;

export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

export const VIDEO_RESOLUTIONS = [
  "480p",
  "720p",
  "768p",
  "1080p",
  "2k",
  "4k",
] as const;

export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
