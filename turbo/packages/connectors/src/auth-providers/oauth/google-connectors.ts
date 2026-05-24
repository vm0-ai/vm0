import type {
  ConnectorType,
  OAuthAuthCodeConnectorType,
} from "../../connectors";

export const GOOGLE_OAUTH_CONNECTOR_TYPES = [
  "gmail",
  "google-ads",
  "google-calendar",
  "google-docs",
  "google-drive",
  "google-meet",
  "google-sheets",
] as const satisfies readonly OAuthAuthCodeConnectorType[];

export type GoogleOAuthConnectorType =
  (typeof GOOGLE_OAUTH_CONNECTOR_TYPES)[number];

const GOOGLE_OAUTH_CONNECTOR_TYPE_SET: ReadonlySet<ConnectorType> =
  new Set<ConnectorType>(GOOGLE_OAUTH_CONNECTOR_TYPES);

/**
 * Check if a connector type uses the shared Google OAuth provider.
 */
export function isGoogleOAuthConnector(
  type: ConnectorType,
): type is GoogleOAuthConnectorType {
  return GOOGLE_OAUTH_CONNECTOR_TYPE_SET.has(type);
}
