import { getFile, buildFileDownloadUrl, type TelegramClient } from "./client";
import { uploadS3Buffer, generatePresignedUrl } from "../infra/s3/s3-client";
import { env } from "../../env";
import { logger } from "../logger";
const log = logger("telegram:images");

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
 * Download a Telegram photo and upload it to R2.
 * Returns a presigned URL that the agent can access.
 */
export async function downloadAndUploadTelegramPhoto(
  client: TelegramClient,
  fileId: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const file = await getFile(client, fileId);
    if (!file.file_path) {
      log.debug("No file_path returned from getFile", { fileId });
      return null;
    }

    if (file.file_size && file.file_size > MAX_FILE_SIZE_BYTES) {
      log.debug("File too large", { fileId, size: file.file_size });
      return null;
    }

    const downloadUrl = buildFileDownloadUrl(client.token, file.file_path);
    const response = await fetch(downloadUrl);

    if (!response.ok) {
      log.debug("Failed to download file", {
        fileId,
        status: response.status,
      });
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Verify image magic bytes
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    const isGif = buffer[0] === 0x47 && buffer[1] === 0x49;
    const isWebp = buffer[0] === 0x52 && buffer[1] === 0x49;

    if (!isPng && !isJpeg && !isGif && !isWebp) {
      log.debug("Downloaded content is not a valid image", {
        fileId,
        firstBytes: buffer.slice(0, 10).toString("hex"),
      });
      return null;
    }

    const contentType = isPng
      ? "image/png"
      : isJpeg
        ? "image/jpeg"
        : isGif
          ? "image/gif"
          : "image/webp";
    const ext = isPng ? "png" : isJpeg ? "jpg" : isGif ? "gif" : "webp";

    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    const s3Key = `telegram-images/${sessionId}/${fileId}.${ext}`;

    await uploadS3Buffer(bucketName, s3Key, buffer, contentType);

    const presignedUrl = await generatePresignedUrl(bucketName, s3Key, 3600);

    log.debug("Uploaded Telegram image to R2", {
      fileId,
      size: buffer.length,
      s3Key,
    });

    return presignedUrl;
  } catch (error) {
    log.debug("Error downloading/uploading Telegram photo", {
      fileId,
      error,
    });
    return null;
  }
}

/**
 * Format a photo as a context entry with a presigned download URL.
 */
export function formatPhotoForContext(
  presignedUrl: string,
  photo: PhotoSizeLike,
): string {
  const parts: string[] = [];
  parts.push(`[image]: photo (image/jpeg)`);
  if (photo.width > 0 && photo.height > 0) {
    parts.push(`   Dimensions: ${photo.width}x${photo.height}`);
  }
  parts.push(
    `   View: curl -sS -o /tmp/${photo.file_id}.jpg "${presignedUrl}" && read /tmp/${photo.file_id}.jpg`,
  );
  return parts.join("\n");
}
