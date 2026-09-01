export const CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY =
  "vm0.connector.appOauthCallbackMetadata";

// Keep a connector here until its OAuth app accepts the App callback URL.
// Intentionally empty: every connector now has the App callback registered with
// its provider. A connector added before its provider console is updated must be
// listed here, otherwise it emits a redirect_uri the provider rejects.
const LEGACY_CALLBACK_CONNECTOR_SLUGS: ReadonlySet<string> = new Set<string>();

// Membership means the application may emit the direct Okou App callback for a
// connector. #28381 admits a connector on either of two grounds:
//   1. launched and provider-ready — its provider console already allowlists
//      https://app.okou.ai/connectors/<slug>/callback; or
//   2. launch-gated and pre-staged — it is not generally launched yet, so its
//      future provider registration only ever needs the Okou callback and no
//      VM0 callback has to be registered or preserved for it.
// Category 2 has no provider allowlist yet, so a manually overridden or
// directly reached start can fail at the provider until its launch registers
// the callback. This set is not an authorization or execution boundary; the
// connector rollout feature switches gate discovery separately. Connectors
// outside this set keep their VM0 App callback.
const DIRECT_OKOU_OAUTH_CALLBACK_READY_CONNECTOR_SLUGS: ReadonlySet<string> =
  new Set([
    "ahrefs",
    "box",
    "cal-com",
    "canva",
    "close",
    "cloudflare",
    "copper",
    "datadog",
    "deel",
    "docusign",
    "dropbox",
    "figma",
    "garmin-connect",
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
    "mailchimp",
    "mercury",
    "meta-ads",
    "microsoft-365",
    "neon",
    "notion",
    "outlook-calendar",
    "outlook-mail",
    "posthog",
    "reddit",
    "slack",
    "spotify",
    "supabase",
    "tiktok-ads",
    "webflow",
    "youtube",
    "zoom",
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
