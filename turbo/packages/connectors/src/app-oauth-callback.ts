export const CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY =
  "vm0.connector.appOauthCallbackMetadata";

// Keep a connector here until its OAuth app accepts the App callback URL.
// Intentionally empty: every connector now has the App callback registered with
// its provider. A connector added before its provider console is updated must be
// listed here, otherwise it emits a redirect_uri the provider rejects.
const LEGACY_CALLBACK_CONNECTOR_SLUGS: ReadonlySet<string> = new Set<string>();

export function isConnectorAppOauthCallbackEnabled(
  connectorSlug: string,
): boolean {
  return !LEGACY_CALLBACK_CONNECTOR_SLUGS.has(connectorSlug);
}
