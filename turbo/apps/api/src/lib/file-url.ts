import { env } from "./env";

const CLERK_USER_ID_PREFIX = "user_";

/**
 * Strip the `user_` prefix from a Clerk user ID for the public `/f/` segment.
 * Non-Clerk IDs (legacy / dev) are returned unchanged.
 */
function publicFileUserIdSegment(userId: string): string {
  return userId.startsWith(CLERK_USER_ID_PREFIX)
    ? userId.slice(CLERK_USER_ID_PREFIX.length)
    : userId;
}

/**
 * Build the permanent URL for an uploaded attachment.
 *
 * The three path segments together reconstruct the S3 key, so the /f route
 * can generate a presigned GET without any database or listing lookup. The
 * URL embeds only stable identifiers (no signature, no expiry), so callers
 * may persist it in chat message content, draft rows, Slack unfurls, or CLI
 * output — the short-lived signature is materialized per-request inside the
 * /f route on each access.
 *
 * Uses VM0_API_URL (public host) so the URL is reachable by anonymous
 * share-by-link consumers that never sign in to the app domain.
 */
export function buildFileUrl(
  userId: string,
  id: string,
  filename: string,
): string {
  const publicUserId = publicFileUserIdSegment(userId);
  return `${env("VM0_API_URL")}/f/${encodeURIComponent(publicUserId)}/${id}/${encodeURIComponent(filename)}`;
}
