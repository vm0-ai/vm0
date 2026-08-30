import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type {
  AvatarVideoAvatar,
  AvatarVideoVoice,
} from "@okouai/api-contracts/contracts/avatar-video";
import {
  avatarTemplateStylePresetId,
  parseAvatarTemplateStylePresetId,
  readAvatarTemplateOptions,
} from "@okouai/core/avatar-template";

import { i18n } from "../../i18n/index.ts";

interface AvatarTemplateSelection {
  readonly avatarId: number;
  readonly aspectRatio?: "portrait" | "landscape" | "square";
  readonly previewUrl?: string;
  readonly title: string;
  readonly voiceId?: string;
}

export function toAvatarGenerationTemplate(
  avatar: AvatarVideoAvatar,
  voice: AvatarVideoVoice,
  aspectRatio: "portrait" | "landscape",
): GenerationTemplateRequest {
  return {
    type: "video",
    selection: {
      stylePresetId: avatarTemplateStylePresetId(avatar.id),
      avatarOptions: {
        titleSnapshot: avatar.name,
        previewUrl: avatar.coverUrl,
        voiceId: voice.id,
        aspectRatio,
      },
    },
  };
}

export function avatarTemplateSelection(
  template: GenerationTemplateRequest | undefined,
): AvatarTemplateSelection | undefined {
  if (template?.type !== "video") {
    return undefined;
  }
  const avatarId = parseAvatarTemplateStylePresetId(
    template.selection.stylePresetId,
  );
  if (avatarId === undefined) {
    return undefined;
  }
  const options = readAvatarTemplateOptions(template.selection);
  return {
    avatarId,
    title:
      options.titleSnapshot ??
      i18n.t(
        ($) => {
          return $.artifacts.templates.avatarWithId;
        },
        { id: avatarId },
      ),
    previewUrl: options.previewUrl,
    voiceId: options.voiceId,
    aspectRatio: options.aspectRatio,
  };
}

export function isSelectedAvatarTemplate(
  avatar: AvatarVideoAvatar,
  template: GenerationTemplateRequest | undefined,
): boolean {
  return avatarTemplateSelection(template)?.avatarId === avatar.id;
}
