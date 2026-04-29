/**
 * Upload limits shared by the presigned-URL prepare endpoint and its callers.
 *
 * The file body never passes through the Next.js runtime — the browser /
 * CLI PUTs straight to R2 using the presigned URL, so we can go all the way
 * up to R2's 5 GB single-PUT ceiling. 1 GB is the policy cap we chose.
 */

export const MAX_UPLOAD_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GB
export const MAX_UPLOAD_SIZE_LABEL = "1 GB";

export const ALLOWED_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/mpga",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/wave",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "application/json",
]);
