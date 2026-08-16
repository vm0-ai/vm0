import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { parseAvatarTemplateStylePresetId } from "@okouai/core/avatar-template";
import {
  VIDEO_MODEL_CONFIGS,
  resolveVideoGenerationOptions,
} from "@okouai/core/video-model-catalog";

/**
 * Every parameter a text-to-video run takes, resolved against the model catalog
 * so the composer chip and a sent message both show what the run will actually
 * use even when the user overrode none of them.
 *
 * Audio is deliberately absent: it is a two-state toggle that most runs leave
 * on, so it earns its place in the settings popover but not in a summary the
 * user reads inside a prompt sentence.
 */
export interface VideoTemplateSpec {
  readonly model: string;
  /** Aspect ratio and duration, which stay visible at any viewport width. */
  readonly core: readonly string[];
  readonly rest: readonly string[];
}

/**
 * Talking-avatar templates share the "video" envelope but take none of these
 * parameters, so they have no spec.
 *
 * Neither does a template with nothing stored on it. The composer no longer
 * writes these parameters — they belong to the run — so a message sent today
 * carries none, and resolving the catalog defaults for it would advertise a
 * model and a duration the run never actually agreed to.
 */
export function videoTemplateSpec(
  template: GenerationTemplateRequest,
): VideoTemplateSpec | null {
  if (template.type !== "video") {
    return null;
  }
  const { selection } = template;
  if (parseAvatarTemplateStylePresetId(selection.stylePresetId) !== undefined) {
    return null;
  }
  if (selection.videoOptions === undefined) {
    return null;
  }
  const resolved = resolveVideoGenerationOptions(selection.videoOptions);
  const config = VIDEO_MODEL_CONFIGS[resolved.model];
  return {
    model: config.label,
    core: [resolved.aspectRatio, resolved.duration],
    rest: [resolved.resolution],
  };
}

export function videoTemplateSpecText(spec: VideoTemplateSpec): string {
  return [spec.model, ...spec.core, ...spec.rest].join(" · ");
}
