/**
 * Catalog of the built-in text-to-video models.
 *
 * Shared so the API generation service and the web composer agree on which
 * parameters each model accepts. Provider request shapes, pricing, and output
 * dimensions stay in the API service.
 */

export const VIDEO_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
const STANDARD_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
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
const MINIMAX_H3_DURATIONS = [
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
export const VIDEO_RESOLUTIONS = [
  "480p",
  "720p",
  "768p",
  "1080p",
  "2k",
  "4k",
] as const;
export const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const SEEDANCE_FAST_RESOLUTIONS = ["480p", "720p"] as const;
const VEO_VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
const KLING_4K_VIDEO_RESOLUTIONS = ["4k"] as const;
const MINIMAX_H3_RESOLUTIONS = ["768p", "2k"] as const;

export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export type SeedanceResolution = (typeof SEEDANCE_RESOLUTIONS)[number];

export type VideoProvider = "byteplus" | "fal" | "minimax";
type VideoModelFamily = "seedance-2" | "seedance-1-5";
type FalRequestFormat = "veo" | "kling";

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

interface MiniMaxVideoModelConfig extends BaseVideoModelConfig {
  readonly provider: "minimax";
}

export type VideoModelConfig =
  | BytePlusVideoModelConfig
  | FalVideoModelConfig
  | MiniMaxVideoModelConfig;

export const VIDEO_MODEL_CONFIGS = {
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
  "MiniMax-H3": {
    provider: "minimax",
    alias: "minimax-h3",
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: MINIMAX_H3_DURATIONS,
    resolutions: MINIMAX_H3_RESOLUTIONS,
    defaultResolution: "2k",
    supportsGenerateAudio: true,
    supportsSeed: false,
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
} as const satisfies Record<string, VideoModelConfig>;

export type VideoModel = keyof typeof VIDEO_MODEL_CONFIGS;

export const VIDEO_MODELS = Object.keys(VIDEO_MODEL_CONFIGS) as VideoModel[];

export const VIDEO_MODEL_ALIASES = {
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
  "minimax-h3": "MiniMax-H3",
  h3: "MiniMax-H3",
} as const satisfies Readonly<Record<string, VideoModel>>;

/** Applied when a generation request omits the parameter. */
export const DEFAULT_VIDEO_MODEL =
  "dreamina-seedance-2-0-fast-260128" satisfies VideoModel;
export const DEFAULT_VIDEO_ASPECT_RATIO = "16:9" satisfies VideoAspectRatio;
export const DEFAULT_VIDEO_DURATION = "8s" satisfies VideoDuration;
