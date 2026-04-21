import { getAppUrl } from "../url";

/**
 * Build the permanent URL for an uploaded attachment.
 *
 * The three path segments together reconstruct the S3 key
 * `uploads/{userId}/{id}/{filename}`, so the /f route can generate a
 * presigned GET without any database or listing lookup. Because the URL
 * embeds only stable identifiers (no signature, no expiry), callers may
 * persist it in chat message content, draft rows, Slack unfurls, or CLI
 * output — the short-lived signature is materialized per-request inside
 * the /f route on each access.
 */
export function buildFileUrl(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${getAppUrl()}/f/${encodeURIComponent(userId)}/${id}/${encodeURIComponent(filename)}`;
}
