import { getAvatarPresets } from "./zero-avatars.ts";
import {
  AVATAR_SVG_PREFIX,
  parseAvatarSvgConfig,
  type AvatarSvgConfig,
} from "./avatar-svg-utils.ts";

const AVATAR_PRESET_PREFIX = "preset:";

/** Return a random preset avatar string like `preset:2`. */
export function randomPresetAvatar(): string {
  return `${AVATAR_PRESET_PREFIX}${Math.floor(Math.random() * getAvatarPresets().length)}`;
}

/**
 * Resolve an avatarUrl to an AvatarSvgConfig for SVG rendering.
 * Returns config for both `preset:N` and `svg:...` values, null otherwise.
 */
export function resolveAvatarSvgConfig(
  avatarUrl: string | null | undefined,
): AvatarSvgConfig | null {
  if (!avatarUrl) {
    return null;
  }
  if (avatarUrl.startsWith(AVATAR_PRESET_PREFIX)) {
    const presets = getAvatarPresets();
    const idx = Number(avatarUrl.slice(AVATAR_PRESET_PREFIX.length));
    return presets[idx] ?? presets[0];
  }
  if (avatarUrl.startsWith(AVATAR_SVG_PREFIX)) {
    return parseAvatarSvgConfig(avatarUrl);
  }
  return null;
}

/**
 * Resolve an avatarUrl value to a displayable image source.
 * - `preset:N` → null (rendered via AvatarSvgPreview)
 * - `svg:...`  → null (rendered via AvatarSvgPreview)
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
    return null;
  }
  if (avatarUrl.startsWith(AVATAR_SVG_PREFIX)) {
    return null;
  }
  return avatarUrl;
}
