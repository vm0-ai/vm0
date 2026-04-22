import { getApiUrl } from "../../infra/callback/dispatcher";

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
 *
 * Uses VM0_API_URL (public host) rather than NEXT_PUBLIC_APP_URL so the
 * URL is reachable by anonymous share-by-link consumers (Slack unfurl
 * bots, email clients, external viewers) that never sign in to the app
 * domain.
 */
export function buildFileUrl(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${getApiUrl()}/f/${encodeURIComponent(userId)}/${id}/${encodeURIComponent(filename)}`;
}
