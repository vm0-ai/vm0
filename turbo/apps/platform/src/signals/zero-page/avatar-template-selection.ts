import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroAvatarVideoAvatar } from "@vm0/api-contracts/contracts/zero-avatar-video";
import {
  avatarTemplateStylePresetId,
  parseAvatarTemplateStylePresetId,
} from "@vm0/core/avatar-template";

import { i18n } from "../../i18n/index.ts";

interface AvatarTemplateSelection {
  readonly avatarId: number;
  readonly previewUrl?: string;
  readonly title: string;
}

export function toAvatarGenerationTemplate(
  avatar: ZeroAvatarVideoAvatar,
): GenerationTemplateRequest {
  return {
    type: "video",
    selection: {
      stylePresetId: avatarTemplateStylePresetId(avatar.id),
      titleSnapshot: avatar.name,
      previewUrl: avatar.coverUrl,
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
  return {
    avatarId,
    title:
      template.selection.titleSnapshot ??
      i18n.t(
        ($) => {
          return $.artifacts.templates.avatarWithId;
        },
        { id: avatarId },
      ),
    previewUrl: template.selection.previewUrl,
  };
}

export function isSelectedAvatarTemplate(
  avatar: ZeroAvatarVideoAvatar,
  template: GenerationTemplateRequest | undefined,
): boolean {
  return avatarTemplateSelection(template)?.avatarId === avatar.id;
}
