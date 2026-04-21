/** Upload limits shared between legacy multipart and presigned PUT endpoints. */

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export const ALLOWED_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);
