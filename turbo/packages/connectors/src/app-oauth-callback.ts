// Keep a connector here until its OAuth app accepts the App callback URL.
export const CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY =
  "vm0.connector.appOauthCallbackMetadata";

const LEGACY_CALLBACK_CONNECTOR_REFS: ReadonlySet<string> = new Set([
  "cloudflare",
  "microsoft-365",
  "outlook-calendar",
  "outlook-mail",
  "slack",
  "xero",
]);

export function isConnectorAppOauthCallbackEnabled(
  connectorRef: string,
): boolean {
  return !LEGACY_CALLBACK_CONNECTOR_REFS.has(connectorRef);
}
