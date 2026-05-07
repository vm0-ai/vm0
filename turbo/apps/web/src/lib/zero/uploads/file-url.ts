import { getApiUrl } from "../../infra/callback/dispatcher";

/**
 * Build the permanent URL for an uploaded attachment.
 *
 * The three path segments together reconstruct the S3 key, so the /f route
 * can generate a presigned GET without any database or listing lookup.
 * Because the URL embeds only stable identifiers (no signature, no expiry),
 * callers may persist it in chat message content, draft rows, Slack unfurls,
 * or CLI output — the short-lived signature is materialized per-request
 * inside the /f route on each access.
 *
 * Uses VM0_API_URL (public host) rather than NEXT_PUBLIC_APP_URL so the
 * URL is reachable by anonymous share-by-link consumers (Slack unfurl
 * bots, email clients, external viewers) that never sign in to the app
 * domain.
 */
const CLERK_USER_ID_PREFIX = "user_";

export function publicFileUserIdSegment(userId: string): string {
  return userId.startsWith(CLERK_USER_ID_PREFIX)
    ? userId.slice(CLERK_USER_ID_PREFIX.length)
    : userId;
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

export function buildFileUrl(
  userId: string,
  id: string,
  filename: string,
): string {
  const publicUserId = publicFileUserIdSegment(userId);
  return `${getApiUrl()}/f/${encodeURIComponent(publicUserId)}/${id}/${encodeURIComponent(filename)}`;
}
