const AVATAR_TEMPLATE_STYLE_PRESET_PREFIX = "avatar-template:";

/**
 * Avatar templates reuse the video template envelope so older frontend
 * bundles can still parse messages created during independent deployments.
 */
export function avatarTemplateStylePresetId(avatarId: number): string {
  if (!Number.isSafeInteger(avatarId) || avatarId <= 0) {
    throw new Error("Avatar id must be a positive safe integer");
  }
  return `${AVATAR_TEMPLATE_STYLE_PRESET_PREFIX}${avatarId}`;
}

export function parseAvatarTemplateStylePresetId(
  stylePresetId: string,
): number | undefined {
  if (!stylePresetId.startsWith(AVATAR_TEMPLATE_STYLE_PRESET_PREFIX)) {
    return undefined;
  }

  const serializedAvatarId = stylePresetId.slice(
    AVATAR_TEMPLATE_STYLE_PRESET_PREFIX.length,
  );
  if (!/^[1-9]\d*$/.test(serializedAvatarId)) {
    return undefined;
  }

  const avatarId = Number(serializedAvatarId);
  return Number.isSafeInteger(avatarId) ? avatarId : undefined;
}

export interface AvatarTemplateOptions {
  readonly titleSnapshot?: string;
  readonly previewUrl?: string;
  readonly voiceId?: string;
  readonly aspectRatio?: "portrait" | "landscape" | "square";
}

/**
 * Nested options win. The flat fields stay readable because messages and
 * server-persisted drafts written by bundles deployed before the split still
 * carry them, and an older bundle re-reading a newer draft drops the nested
 * object during validation.
 */
export function readAvatarTemplateOptions(
  selection: AvatarTemplateOptions & {
    readonly avatarOptions?: AvatarTemplateOptions;
  },
): AvatarTemplateOptions {
  const nested = selection.avatarOptions;
  return {
    titleSnapshot: nested?.titleSnapshot ?? selection.titleSnapshot,
    previewUrl: nested?.previewUrl ?? selection.previewUrl,
    voiceId: nested?.voiceId ?? selection.voiceId,
    aspectRatio: nested?.aspectRatio ?? selection.aspectRatio,
  };
}
