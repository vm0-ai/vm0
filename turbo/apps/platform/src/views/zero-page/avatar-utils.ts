import { ZERO_AVATARS } from "./zero-avatars.ts";

export const AVATAR_PRESET_PREFIX = "preset:";

/**
 * Resolve an avatarUrl value to a displayable image source.
 * - `preset:N` → bundled avatar image
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
  return avatarUrl;
}
