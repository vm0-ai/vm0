import { env } from "./env";

const ARTIFACTS_PREFIX = "artifacts";
const CLERK_USER_ID_PREFIX = "user_";

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

export function storageUserIdFromFileUrlSegment(userIdSegment: string): string {
  // Preserve old `/f/user_...` links and non-Clerk/dev IDs such as `user-1`.
  if (
    userIdSegment === "user" ||
    userIdSegment.startsWith(CLERK_USER_ID_PREFIX) ||
    userIdSegment.startsWith("user-")
  ) {
    return userIdSegment;
  }
  return `${CLERK_USER_ID_PREFIX}${userIdSegment}`;
}

/**
 * Build the permanent URL for an uploaded attachment.
 *
 * New artifact URLs point directly at the public CDN. Legacy `/f/...` URLs
 * remain supported by the API compatibility route, but callers should persist
 * and copy the CDN URL returned here.
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
