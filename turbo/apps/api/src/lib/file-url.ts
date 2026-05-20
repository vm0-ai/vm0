import { env } from "./env";

const ARTIFACTS_PREFIX = "artifacts";

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
 *
 * New artifact URLs point directly at the public CDN. Legacy `/f/...` URLs
 * remain supported by the web compatibility route, but callers should persist
 * and copy the CDN URL returned here.
 */
export function buildFileUrl(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${publicArtifactsBaseUrl()}/${buildArtifactKey(userId, id, filename)}`;
}
