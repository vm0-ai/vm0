import { env } from "../../../env";

/**
 * Build the permanent URL for an uploaded attachment.
 *
 * New artifact URLs point directly at the public CDN. Legacy `/f/...` URLs
 * remain supported by the web compatibility route, but callers should persist
 * and copy the CDN URL returned here.
 */
const CLERK_USER_ID_PREFIX = "user_";
const ARTIFACTS_PREFIX = "artifacts";

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

function publicArtifactsBaseUrl(): string {
  return env().PUBLIC_ARTIFACTS_BASE_URL.replace(/\/+$/, "");
}

export function buildArtifactKey(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(userId)}/${id}/${encodeURIComponent(filename)}`;
}

export function buildFileUrl(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${publicArtifactsBaseUrl()}/${buildArtifactKey(userId, id, filename)}`;
}
