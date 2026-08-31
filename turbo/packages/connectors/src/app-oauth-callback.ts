export const CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY =
  "vm0.connector.appOauthCallbackMetadata";

// Keep a connector here until its OAuth app accepts the App callback URL.
// Intentionally empty: every connector now has the App callback registered with
// its provider. A connector added before its provider console is updated must be
// listed here, otherwise it emits a redirect_uri the provider rejects.
const LEGACY_CALLBACK_CONNECTOR_SLUGS: ReadonlySet<string> = new Set<string>();

// Provider allowlists roll out independently of the API. Until #28381 confirms
// every provider is ready, unlisted connectors must keep their VM0 App callback.
const DIRECT_OKOU_OAUTH_CALLBACK_READY_CONNECTOR_SLUGS: ReadonlySet<string> =
  new Set([
    "box",
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
    "hubspot",
    "meta-ads",
    "microsoft-365",
    "notion",
    "outlook-calendar",
    "outlook-mail",
    "slack",
    "tiktok-ads",
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
