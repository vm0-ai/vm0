import type {
  ConnectorType,
  OAuthConnectorType,
} from "@vm0/connectors/connectors";
import { getRuntimeAvailableConnectorTypes as getRuntimeAvailableConnectorTypesFromEnv } from "@vm0/connectors/connector-utils";
import {
  type AuthUrlResult,
  type OAuthAuthorizeArgs,
  type OAuthExchangeArgs,
  type OAuthRefreshArgs,
  type OAuthRefreshResult,
  providerEnvFromObject,
  isOAuthRefreshProvider,
  type OAuthTokenResult,
  type OAuthConnectorProvider,
  type ProviderEnv,
} from "./provider-types";
import { ahrefsProvider } from "./providers/ahrefs-provider";
import { airtableProvider } from "./providers/airtable-provider";
import { asanaProvider } from "./providers/asana-provider";
import { canvaProvider } from "./providers/canva-provider";
import { closeProvider } from "./providers/close-provider";
import { deelProvider } from "./providers/deel-provider";
import { docusignProvider } from "./providers/docusign-provider";
import { dropboxProvider } from "./providers/dropbox-provider";
import { figmaProvider } from "./providers/figma-provider";
import { garminConnectProvider } from "./providers/garmin-connect-provider";
import { gumroadProvider } from "./providers/gumroad-provider";
import { githubProvider } from "./providers/github-provider";
import { gmailProvider } from "./providers/gmail-provider";
import { hubspotProvider } from "./providers/hubspot-provider";
import { googleAdsProvider } from "./providers/google-ads-provider";
import { googleCalendarProvider } from "./providers/google-calendar-provider";
import { googleDocsProvider } from "./providers/google-docs-provider";
import { googleDriveProvider } from "./providers/google-drive-provider";
import { googleMeetProvider } from "./providers/google-meet-provider";
import { googleSheetsProvider } from "./providers/google-sheets-provider";
import { linearProvider } from "./providers/linear-provider";
import { mailchimpProvider } from "./providers/mailchimp-provider";
import { mercuryProvider } from "./providers/mercury-provider";
import { mondayProvider } from "./providers/monday-provider";
import { neonProvider } from "./providers/neon-provider";
import { notionProvider } from "./providers/notion-provider";
import { outlookCalendarProvider } from "./providers/outlook-calendar-provider";
import { outlookMailProvider } from "./providers/outlook-mail-provider";
import { redditProvider } from "./providers/reddit-provider";
import { intervalsIcuProvider } from "./providers/intervals-icu-provider";
import { sentryProvider } from "./providers/sentry-provider";
import { slackProvider } from "./providers/slack-provider";
import { stravaProvider } from "./providers/strava-provider";
import { stripeProvider } from "./providers/stripe-provider";
import { todoistProvider } from "./providers/todoist-provider";
import { vercelProvider } from "./providers/vercel-provider";
import { webflowProvider } from "./providers/webflow-provider";
import { supabaseProvider } from "./providers/supabase-provider";
import { metaAdsProvider } from "./providers/meta-ads-provider";
import { posthogProvider } from "./providers/posthog-provider";
import { spotifyProvider } from "./providers/spotify-provider";
import { xProvider } from "./providers/x-provider";
import { xeroProvider } from "./providers/xero-provider";
import { zoomProvider } from "./providers/zoom-provider";
import { testOauthProvider } from "./providers/test-oauth-provider";

export type {
  AuthUrlResult,
  OAuthAuthorizeArgs,
  OAuthExchangeArgs,
  OAuthRefreshArgs,
  OAuthRefreshResult,
  OAuthTokenResult,
};
export type { ProviderEnv };
export { providerEnvFromObject, isOAuthRefreshProvider };

export const CONNECTOR_OAUTH_PROVIDERS = {
  ahrefs: ahrefsProvider,
  airtable: airtableProvider,
  asana: asanaProvider,
  canva: canvaProvider,
  close: closeProvider,
  deel: deelProvider,
  docusign: docusignProvider,
  dropbox: dropboxProvider,
  figma: figmaProvider,
  "garmin-connect": garminConnectProvider,
  gumroad: gumroadProvider,
  github: githubProvider,
  gmail: gmailProvider,
  hubspot: hubspotProvider,
  "google-ads": googleAdsProvider,
  "google-calendar": googleCalendarProvider,
  "google-docs": googleDocsProvider,
  "google-drive": googleDriveProvider,
  "google-meet": googleMeetProvider,
  "google-sheets": googleSheetsProvider,
  linear: linearProvider,
  mailchimp: mailchimpProvider,
  mercury: mercuryProvider,
  monday: mondayProvider,
  neon: neonProvider,
  notion: notionProvider,
  "outlook-calendar": outlookCalendarProvider,
  "outlook-mail": outlookMailProvider,
  reddit: redditProvider,
  "intervals-icu": intervalsIcuProvider,
  sentry: sentryProvider,
  slack: slackProvider,
  strava: stravaProvider,
  stripe: stripeProvider,
  todoist: todoistProvider,
  vercel: vercelProvider,
  webflow: webflowProvider,
  supabase: supabaseProvider,
  "meta-ads": metaAdsProvider,
  posthog: posthogProvider,
  spotify: spotifyProvider,
  x: xProvider,
  xero: xeroProvider,
  zoom: zoomProvider,
  "test-oauth": testOauthProvider,
} satisfies Record<OAuthConnectorType, OAuthConnectorProvider>;

export function isOAuthConnectorType(type: string): type is OAuthConnectorType {
  return Object.hasOwn(CONNECTOR_OAUTH_PROVIDERS, type);
}

export function getConnectorOAuthProvider(
  type: string,
): OAuthConnectorProvider | undefined {
  if (!isOAuthConnectorType(type)) {
    return undefined;
  }
  return CONNECTOR_OAUTH_PROVIDERS[type];
}

/**
 * Returns connector types the current runtime environment can offer as
 * connection candidates.
 */
export function getRuntimeAvailableConnectorTypes(
  currentEnv: ProviderEnv,
): ConnectorType[] {
  return getRuntimeAvailableConnectorTypesFromEnv((name) => {
    const value = currentEnv[name];
    return typeof value === "string" ? value : undefined;
  });
}
