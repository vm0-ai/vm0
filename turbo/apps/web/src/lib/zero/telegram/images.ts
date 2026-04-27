/** Maximum file size to download (10MB) */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Minimal photo fields needed for picking the best size */
interface PhotoSizeLike {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/**
 * Pick the best photo size from Telegram's array.
 * Telegram provides multiple sizes; pick the largest that's within our size limit.
 */
export function pickBestPhoto<T extends PhotoSizeLike>(
  photos: T[],
): T | undefined {
  if (photos.length === 0) {
    return undefined;
  }

  // Sort by area descending, pick first that fits size limit
  const sorted = [...photos].sort((a, b) => {
    return b.width * b.height - a.width * a.height;
  });

  for (const photo of sorted) {
    if (!photo.file_size || photo.file_size <= MAX_FILE_SIZE_BYTES) {
      return photo;
    }
  }

  // All too large — pick the smallest
  return sorted[sorted.length - 1];
}

/**
 * Format a Telegram photo as an on-demand file reference for the agent.
 * The agent can download it with
 * `zero telegram download-file <file-id> --bot-id <bot-id>`.
 */
export function formatTelegramFileForContext(
  photo: PhotoSizeLike,
  opts?: { botId?: string },
): string {
  const parts: string[] = [];
  parts.push("[Telegram file] photo (image/jpeg)");
  if (photo.width > 0 && photo.height > 0) {
    parts.push(`   [Dimensions] ${photo.width}x${photo.height}`);
  }
  if (photo.file_size) {
    parts.push(`   [Size] ${photo.file_size} bytes`);
  }
  parts.push(`   [ID] ${photo.file_id}`);
  if (opts?.botId) {
    parts.push(`   [Bot ID] ${opts.botId}`);
  }
  return parts.join("\n");
}
