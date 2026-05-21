import type { ConnectorType, OAuthConnectorType } from "../connectors";

export const GOOGLE_OAUTH_CONNECTOR_TYPES = [
  "gmail",
  "google-ads",
  "google-calendar",
  "google-docs",
  "google-drive",
  "google-meet",
  "google-sheets",
] as const satisfies readonly OAuthConnectorType[];

export type GoogleOAuthConnectorType =
  (typeof GOOGLE_OAUTH_CONNECTOR_TYPES)[number];

const GOOGLE_OAUTH_CONNECTOR_TYPE_SET: ReadonlySet<ConnectorType> =
  new Set<ConnectorType>(GOOGLE_OAUTH_CONNECTOR_TYPES);

export function isGoogleOAuthConnectorType(
  type: ConnectorType,
): type is GoogleOAuthConnectorType {
  return GOOGLE_OAUTH_CONNECTOR_TYPE_SET.has(type);
}
