export const GOOGLE_OAUTH_CONNECTOR_TYPES = [
  "gmail",
  "google-ads",
  "google-analytics",
  "google-calendar",
  "google-cloud",
  "google-contacts",
  "google-docs",
  "google-drive",
  "google-forms",
  "google-maps",
  "google-meet",
  "google-search-console",
  "google-sheets",
  "youtube",
] as const;

export type GoogleOAuthConnectorType =
  (typeof GOOGLE_OAUTH_CONNECTOR_TYPES)[number];

const GOOGLE_OAUTH_CONNECTOR_TYPE_SET: ReadonlySet<string> = new Set(
  GOOGLE_OAUTH_CONNECTOR_TYPES,
);

/**
 * Check if a connector type uses the shared Google OAuth provider.
 */
export function isGoogleOAuthConnector(
  type: string,
): type is GoogleOAuthConnectorType {
  return GOOGLE_OAUTH_CONNECTOR_TYPE_SET.has(type);
}
