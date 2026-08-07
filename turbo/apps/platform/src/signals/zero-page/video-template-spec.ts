import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { parseAvatarTemplateStylePresetId } from "@vm0/core/avatar-template";
import {
  VIDEO_MODEL_CONFIGS,
  resolveVideoGenerationOptions,
} from "@vm0/core/video-model-catalog";
import { i18n } from "../../i18n/index.ts";

/**
 * Every parameter a text-to-video run takes, resolved against the model catalog
 * so the composer chip and a sent message both show what the run will actually
 * use even when the user overrode none of them.
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
  const resolved = resolveVideoGenerationOptions(selection.videoOptions);
  const config = VIDEO_MODEL_CONFIGS[resolved.model];
  const audio = resolved.generateAudio
    ? i18n.t(($) => {
        return $.chat.templates.videoSpecAudioOn;
      })
    : i18n.t(($) => {
        return $.chat.templates.videoSpecAudioOff;
      });
  return {
    model: config.label,
    core: [resolved.aspectRatio, resolved.duration],
    rest: config.supportsGenerateAudio
      ? [resolved.resolution, audio]
      : [resolved.resolution],
  };
}

export function videoTemplateSpecText(spec: VideoTemplateSpec): string {
  return [spec.model, ...spec.core, ...spec.rest].join(" · ");
}
