import { AVATAR_PRESET_PREFIX } from "@okouai/core/agent-avatar";
import { getAvatarPresets } from "./avatars.ts";
import {
  AVATAR_SVG_PREFIX,
  parseAvatarSvgConfig,
  type ResolvedAvatarSvgConfig,
} from "./avatar-svg-utils.ts";

/**
 * Resolve an avatarUrl to an AvatarSvgConfig for SVG rendering.
 * Returns config for both `preset:N` and `svg:...` values, null otherwise.
 */
export function resolveAvatarSvgConfig(
  avatarUrl: string | null | undefined,
): ResolvedAvatarSvgConfig | null {
  if (!avatarUrl) {
    return null;
  }
  if (avatarUrl.startsWith(AVATAR_PRESET_PREFIX)) {
    const presets = getAvatarPresets();
    const idx = Number(avatarUrl.slice(AVATAR_PRESET_PREFIX.length));
    return presets[idx] ?? presets[0];
  }
  return parseAvatarSvgConfig(avatarUrl);
}

/**
 * Resolve an avatarUrl value to a displayable image source.
 * - `preset:N` → null (rendered via AvatarSvgPreview)
 * - legacy `svg:...` and valid composer URLs → null (rendered via layers)
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
  if (
    avatarUrl.startsWith(AVATAR_SVG_PREFIX) ||
    parseAvatarSvgConfig(avatarUrl)
  ) {
    return null;
  }
  return avatarUrl;
}
