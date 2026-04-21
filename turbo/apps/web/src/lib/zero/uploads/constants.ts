/**
 * Upload limits.
 *
 * The presigned path (`/api/zero/uploads/prepare` → browser PUT to R2) can
 * handle 1 GB because the bytes never pass through the Next.js runtime.
 *
 * The legacy multipart path (`POST /api/zero/uploads`, used by the CLI)
 * is capped much lower because Vercel's serverless body limit is ~4.5 MB
 * and `next dev` starts failing well before 1 GB. Keeping a code-level cap
 * there produces a clean 400 instead of a runtime-level surprise.
 */

export const MAX_PRESIGNED_UPLOAD_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GB
export const MAX_PRESIGNED_UPLOAD_SIZE_LABEL = "1 GB";

export const MAX_MULTIPART_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_MULTIPART_UPLOAD_SIZE_LABEL = "100 MB";

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
