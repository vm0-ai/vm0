import { env } from "./env";

const CLERK_USER_ID_PREFIX = "user_";
const ARTIFACTS_PREFIX = "artifacts";

/**
 * Strip the `user_` prefix from a Clerk user ID for public artifact paths.
 * Non-Clerk IDs (legacy / dev) are returned unchanged.
 */
function publicFileUserIdSegment(userId: string): string {
  return userId.startsWith(CLERK_USER_ID_PREFIX)
    ? userId.slice(CLERK_USER_ID_PREFIX.length)
    : userId;
}

function publicArtifactsBaseUrl(): string {
  return env("PUBLIC_ARTIFACTS_BASE_URL").replace(/\/+$/, "");
}

export function buildArtifactKey(
  userId: string,
  id: string,
  filename: string,
): string {
  const publicUserId = publicFileUserIdSegment(userId);
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(publicUserId)}/${id}/${encodeURIComponent(filename)}`;
}

export function buildArtifactPrefix(userId: string, id: string): string {
  const publicUserId = publicFileUserIdSegment(userId);
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(publicUserId)}/${id}/`;
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
