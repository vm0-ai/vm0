import { env } from "./env";

const ARTIFACTS_PREFIX = "artifacts";

/**
 * Sanitize a user-supplied filename for use in an artifact object key.
 * Replaces characters that are unsafe or problematic in URLs / object storage
 * (spaces, non-ASCII, etc.) with underscores so the key is stable and
 * predictable across upload, message storage, and retrieval.
 */
export function sanitizeArtifactFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function publicArtifactsBaseUrl(): string {
  return env("PUBLIC_ARTIFACTS_BASE_URL").replace(/\/+$/, "");
}

export function buildArtifactKey(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(userId)}/${id}/${encodeURIComponent(filename)}`;
}

export function buildArtifactPrefix(userId: string, id: string): string {
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(userId)}/${id}/`;
}

/**
 * Build the permanent URL for an uploaded attachment.
 */
export function buildFileUrl(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${publicArtifactsBaseUrl()}/${buildArtifactKey(userId, id, filename)}`;
}

export function buildFileUrlFromKey(key: string): string {
  return `${publicArtifactsBaseUrl()}/${key.replace(/^\/+/, "")}`;
}
