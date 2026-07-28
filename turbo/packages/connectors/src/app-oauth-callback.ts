// Add a connector only after its OAuth app accepts the App callback URL.
export const CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY =
  "vm0.connector.appOauthCallbackMetadata";

const ENABLED_CONNECTOR_REFS: ReadonlySet<string> = new Set([
  "github",
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
  "hubspot",
  "intervals-icu",
  "linear",
  "meta-ads",
  "mercury",
  "notion",
  "sentry",
  "stripe",
  "vercel",
  "x",
  "youtube",
]);

export function isConnectorAppOauthCallbackEnabled(
  connectorRef: string,
): boolean {
  return ENABLED_CONNECTOR_REFS.has(connectorRef);
}
