// Keep a connector here until its OAuth app accepts the App callback URL.
export const CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY =
  "vm0.connector.appOauthCallbackMetadata";

const LEGACY_CALLBACK_CONNECTOR_SLUGS: ReadonlySet<string> = new Set(["slack"]);

export function isConnectorAppOauthCallbackEnabled(
  connectorSlug: string,
): boolean {
  return !LEGACY_CALLBACK_CONNECTOR_SLUGS.has(connectorSlug);
}
