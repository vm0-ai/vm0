// Keep a connector here until its OAuth app accepts the App callback URL.
export const CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY =
  "vm0.connector.appOauthCallbackMetadata";

const LEGACY_CALLBACK_CONNECTOR_SLUGS: ReadonlySet<string> = new Set(["slack"]);

// Provider allowlists roll out independently of the API. Until #28381 confirms
// every provider is ready, unlisted connectors must keep their VM0 App callback.
const DIRECT_OKOU_OAUTH_CALLBACK_READY_CONNECTOR_SLUGS: ReadonlySet<string> =
  new Set([
    "cloudflare",
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
    "microsoft-365",
    "outlook-calendar",
    "outlook-mail",
    "youtube",
  ]);

export function isConnectorAppOauthCallbackEnabled(
  connectorSlug: string,
): boolean {
  return !LEGACY_CALLBACK_CONNECTOR_SLUGS.has(connectorSlug);
}

export function isConnectorDirectOkouOauthCallbackReady(
  connectorSlug: string,
): boolean {
  return DIRECT_OKOU_OAUTH_CALLBACK_READY_CONNECTOR_SLUGS.has(connectorSlug);
}
