/**
 * Catalog of the built-in text-to-video models.
 *
 * Shared so the API generation service and the web composer agree on which
 * parameters each model accepts. Provider request shapes, pricing, and output
 * dimensions stay in the API service.
 */

import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoModelId,
  type VideoResolution,
} from "@okouai/api-contracts/contracts/video-models";

/**
 * Re-exported so consumers reach every video model value through one module
 * instead of splitting imports between the catalog and the contract package.
 */
export {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoResolution,
};

const STANDARD_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
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
const SEEDANCE_2_5_DURATIONS = [
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
export const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const SEEDANCE_FAST_RESOLUTIONS = ["480p", "720p"] as const;
const VEO_VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
const KLING_4K_VIDEO_RESOLUTIONS = ["4k"] as const;
const MINIMAX_H3_RESOLUTIONS = ["768p", "2k"] as const;

export type SeedanceResolution = (typeof SEEDANCE_RESOLUTIONS)[number];

export type VideoProvider = "byteplus" | "fal" | "minimax";
type VideoModelFamily = "seedance-2-5" | "seedance-2" | "seedance-1-5";
type FalRequestFormat = "veo" | "kling";

interface BaseVideoModelConfig {
  /** Value accepted by the CLI's `--model` flag. */
  readonly alias: string;
  /** Human-facing name for pickers. */
  readonly label: string;
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
  /**
   * Whether the user-facing picker offers the model. A private model still
   * generates through its alias and through defaults that name it; the flag
   * only decides whether it is worth presenting as a choice.
   */
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
  "dreamina-seedance-2-5-260628": {
    provider: "byteplus",
    alias: "dreamina-seedance-2.5",
    label: "Seedance 2.5",
    family: "seedance-2-5",
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: SEEDANCE_2_5_DURATIONS,
    resolutions: SEEDANCE_RESOLUTIONS,
    defaultResolution: "720p",
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
  "dreamina-seedance-2-0-260128": {
    provider: "byteplus",
    alias: "dreamina-seedance-2.0",
    label: "Seedance 2.0",
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
    label: "Seedance 2.0 fast",
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
    public: false,
  },
  "dreamina-seedance-2-0-mini-260615": {
    provider: "byteplus",
    alias: "dreamina-seedance-2.0-mini",
    label: "Seedance 2.0 Mini",
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
    public: false,
  },
  "seedance-1-5-pro-251215": {
    provider: "byteplus",
    alias: "seedance-1.5-pro",
    label: "Seedance 1.5 pro",
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
    label: "Veo 3.1 fast",
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
    label: "Kling v3 4K",
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
    label: "MiniMax H3",
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
} as const satisfies Record<VideoModelId, VideoModelConfig>;

export type VideoModel = VideoModelId;

export const VIDEO_MODELS = Object.keys(VIDEO_MODEL_CONFIGS) as VideoModel[];

/** The subset a user-facing picker offers; the rest stay CLI-only. */
export const PUBLIC_VIDEO_MODELS = VIDEO_MODELS.filter((model) => {
  return VIDEO_MODEL_CONFIGS[model].public;
});

export const VIDEO_MODEL_ALIASES = {
  "dreamina-seedance-2.5": "dreamina-seedance-2-5-260628",
  "dreamina-seedance-2-5": "dreamina-seedance-2-5-260628",
  "dreamina-seedance-2.0": "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2-0": "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2.0-fast": "dreamina-seedance-2-0-fast-260128",
  "dreamina-seedance-2-0-fast": "dreamina-seedance-2-0-fast-260128",
  "dreamina-seedance-2.0-mini": "dreamina-seedance-2-0-mini-260615",
  "dreamina-seedance-2-0-mini": "dreamina-seedance-2-0-mini-260615",
  "seedance-1.5-pro": "seedance-1-5-pro-251215",
  "seedance-1-5-pro": "seedance-1-5-pro-251215",
  "seedance2.5": "dreamina-seedance-2-5-260628",
  "seedance2.0": "dreamina-seedance-2-0-260128",
  "seedance2.0-fast": "dreamina-seedance-2-0-fast-260128",
  "seedance2.0-mini": "dreamina-seedance-2-0-mini-260615",
  "veo3.1-fast": "fal-ai/veo3.1/fast",
  "kling-v3-4k": "fal-ai/kling-video/v3/4k/text-to-video",
  "minimax-h3": "MiniMax-H3",
  h3: "MiniMax-H3",
} as const satisfies Readonly<Record<string, VideoModel>>;

/**
 * Applied when a generation request omits the parameter. It has to be one of
 * `PUBLIC_VIDEO_MODELS`: the picker marks the model a run would use by matching
 * it against the rows it offers, so a private default leaves every row unmarked
 * while runs quietly use it anyway.
 */
export const DEFAULT_VIDEO_MODEL =
  "dreamina-seedance-2-0-260128" satisfies VideoModel;

/**
 * What help text names when it points at the default. Derived rather than
 * spelled out again, because a hand-written copy keeps naming the previous
 * default after this one moves.
 */
export const DEFAULT_VIDEO_MODEL_ALIAS =
  VIDEO_MODEL_CONFIGS[DEFAULT_VIDEO_MODEL].alias;
export const DEFAULT_VIDEO_ASPECT_RATIO = "16:9" satisfies VideoAspectRatio;
export const DEFAULT_VIDEO_DURATION = "8s" satisfies VideoDuration;

export interface ResolvedVideoGenerationOptions {
  readonly model: VideoModel;
  readonly aspectRatio: VideoAspectRatio;
  readonly duration: VideoDuration;
  readonly resolution: VideoResolution;
  readonly generateAudio: boolean;
}

/**
 * Fills in what the user has not chosen, mirroring what the generation service
 * would apply. Stored options are sparse and can also name a value the chosen
 * model does not accept, which is what happens after switching model; those
 * fall back the same way the service falls back rather than being kept.
 */
export function resolveVideoGenerationOptions(
  options:
    | {
        readonly model?: VideoModel;
        readonly aspectRatio?: VideoAspectRatio;
        readonly duration?: VideoDuration;
        readonly resolution?: VideoResolution;
        readonly generateAudio?: boolean;
      }
    | undefined,
): ResolvedVideoGenerationOptions {
  const model = options?.model ?? DEFAULT_VIDEO_MODEL;
  const config: VideoModelConfig = VIDEO_MODEL_CONFIGS[model];
  const aspectRatio = options?.aspectRatio;
  const duration = options?.duration;
  const resolution = options?.resolution;
  return {
    model,
    aspectRatio:
      aspectRatio !== undefined && config.aspectRatios.includes(aspectRatio)
        ? aspectRatio
        : DEFAULT_VIDEO_ASPECT_RATIO,
    duration:
      duration !== undefined && config.durations.includes(duration)
        ? duration
        : DEFAULT_VIDEO_DURATION,
    resolution:
      resolution !== undefined && config.resolutions.includes(resolution)
        ? resolution
        : config.defaultResolution,
    generateAudio: config.supportsGenerateAudio
      ? (options?.generateAudio ?? true)
      : false,
  };
}
