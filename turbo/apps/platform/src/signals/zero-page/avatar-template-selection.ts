import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type {
  ZeroAvatarVideoAvatar,
  ZeroAvatarVideoVoice,
} from "@vm0/api-contracts/contracts/zero-avatar-video";
import {
  avatarTemplateStylePresetId,
  parseAvatarTemplateStylePresetId,
  readAvatarTemplateOptions,
} from "@vm0/core/avatar-template";

import { i18n } from "../../i18n/index.ts";

interface AvatarTemplateSelection {
  readonly avatarId: number;
  readonly aspectRatio?: "portrait" | "landscape" | "square";
  readonly previewUrl?: string;
  readonly title: string;
  readonly voiceId?: string;
}

export function toAvatarGenerationTemplate(
  avatar: ZeroAvatarVideoAvatar,
  voice: ZeroAvatarVideoVoice,
  aspectRatio: "portrait" | "landscape",
): GenerationTemplateRequest {
  const avatarOptions = {
    titleSnapshot: avatar.name,
    previewUrl: avatar.coverUrl,
    voiceId: voice.id,
    aspectRatio,
  };
  return {
    type: "video",
    selection: {
      stylePresetId: avatarTemplateStylePresetId(avatar.id),
      avatarOptions,
      // Mirrored flat because an API or frontend bundle that predates
      // avatarOptions drops the nested object, and losing the voice would
      // silently generate the avatar with a different one.
      //
      // Delete once the web-client floor in web-client-compatibility.json has
      // been raised past the app version shipping this change. Tracked in
      // https://github.com/vm0-ai/vm0/issues/25620.
      ...avatarOptions,
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
  avatar: ZeroAvatarVideoAvatar,
  template: GenerationTemplateRequest | undefined,
): boolean {
  return avatarTemplateSelection(template)?.avatarId === avatar.id;
}
