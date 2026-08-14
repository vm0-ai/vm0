import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { parseAvatarTemplateStylePresetId } from "@okouai/core/avatar-template";
import {
  VIDEO_MODEL_CONFIGS,
  resolveVideoGenerationOptions,
} from "@okouai/core/video-model-catalog";

/**
 * Every per-generation parameter a text-to-video run takes, resolved against
 * the model catalog so the composer chip and a sent message show the effective
 * values even when the user overrode none of them.
 *
 * Audio is deliberately absent: it is a two-state toggle that most runs leave
 * on, so it earns its place in the settings popover but not in a summary the
 * user reads inside a prompt sentence.
 */
export interface VideoTemplateSpec {
  /** Aspect ratio and duration, which stay visible at any viewport width. */
  readonly core: readonly string[];
  readonly rest: readonly string[];
}

type VideoGenerationTemplateRequest = Extract<
  GenerationTemplateRequest,
  { type: "video" }
>;

function regularVideoTemplate(
  template: GenerationTemplateRequest,
): VideoGenerationTemplateRequest | null {
  if (template.type !== "video") {
    return null;
  }
  if (
    parseAvatarTemplateStylePresetId(template.selection.stylePresetId) !==
    undefined
  ) {
    return null;
  }
  return template;
}

/**
 * Talking-avatar templates share the "video" envelope but take none of these
 * parameters, so they have no spec.
 */
export function videoTemplateSpec(
  template: GenerationTemplateRequest,
): VideoTemplateSpec | null {
  const videoTemplate = regularVideoTemplate(template);
  if (videoTemplate === null) {
    return null;
  }
  const resolved = resolveVideoGenerationOptions(
    videoTemplate.selection.videoOptions,
  );
  return {
    core: [resolved.aspectRatio, resolved.duration],
    rest: [resolved.resolution],
  };
}

export function videoTemplateSpecText(spec: VideoTemplateSpec): string {
  return [...spec.core, ...spec.rest].join(" · ");
}

/**
 * Exact pre-switch chip text. Remove this compatibility path with the feature
 * switch after every caller uses the run-owned model behavior.
 */
export function legacyVideoTemplateSpecText(
  template: GenerationTemplateRequest,
): string | null {
  const videoTemplate = regularVideoTemplate(template);
  if (videoTemplate === null) {
    return null;
  }
  const resolved = resolveVideoGenerationOptions(
    videoTemplate.selection.videoOptions,
  );
  return [
    VIDEO_MODEL_CONFIGS[resolved.model].label,
    resolved.aspectRatio,
    resolved.duration,
    resolved.resolution,
  ].join(" · ");
}

/** Everything the chip's settings zone shows. */
export function videoTemplateSettingsText(spec: VideoTemplateSpec): string {
  return [...spec.core, ...spec.rest].join(" · ");
}
