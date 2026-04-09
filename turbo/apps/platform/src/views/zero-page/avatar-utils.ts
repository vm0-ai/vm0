import { ZERO_AVATARS } from "./zero-avatars.ts";
import { AVATAR_SVG_PREFIX } from "./avatar-svg-utils.ts";

export const AVATAR_PRESET_PREFIX = "preset:";

/** Return a random preset avatar string like `preset:2`. */
export function randomPresetAvatar(): string {
  return `${AVATAR_PRESET_PREFIX}${Math.floor(Math.random() * ZERO_AVATARS.length)}`;
}

/** Check whether the avatarUrl encodes a layered SVG avatar. */
export function isAvatarSvg(avatarUrl: string | null | undefined): boolean {
  return !!avatarUrl?.startsWith(AVATAR_SVG_PREFIX);
}

/**
 * Resolve an avatarUrl value to a displayable image source.
 * - `preset:N` → bundled avatar image
 * - `svg:...`  → null (must be rendered via AvatarSvgPreview)
 * - any other string → treated as a URL (custom upload)
 * - null/undefined → null (caller should fall back)
 */
export function resolveAvatarUrl(
  avatarUrl: string | null | undefined,
): string | null {
  if (!avatarUrl) {
    return null;
  }
  if (avatarUrl.startsWith(AVATAR_PRESET_PREFIX)) {
    const idx = Number(avatarUrl.slice(AVATAR_PRESET_PREFIX.length));
    return ZERO_AVATARS[idx] ?? ZERO_AVATARS[0];
  }
  if (avatarUrl.startsWith(AVATAR_SVG_PREFIX)) {
    return null;
  }
  return avatarUrl;
}
