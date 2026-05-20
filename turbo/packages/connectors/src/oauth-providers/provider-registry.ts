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
  buildProviderAuthUrl,
  exchangeProviderCode,
  refreshProviderToken,
  providerEnvFromObject,
  providerSupportsRefresh,
  type OAuthTokenResult,
  type ProviderHandler,
  type ProviderEnv,
} from "./provider-types";
import { ahrefsHandler } from "./providers/ahrefs-handler";
import { airtableHandler } from "./providers/airtable-handler";
import { asanaHandler } from "./providers/asana-handler";
import { canvaHandler } from "./providers/canva-handler";
import { closeHandler } from "./providers/close-handler";
import { deelHandler } from "./providers/deel-handler";
import { docusignHandler } from "./providers/docusign-handler";
import { dropboxHandler } from "./providers/dropbox-handler";
import { figmaHandler } from "./providers/figma-handler";
import { garminConnectHandler } from "./providers/garmin-connect-handler";
import { gumroadHandler } from "./providers/gumroad-handler";
import { githubHandler } from "./providers/github-handler";
import { gmailHandler } from "./providers/gmail-handler";
import { hubspotHandler } from "./providers/hubspot-handler";
import { googleAdsHandler } from "./providers/google-ads-handler";
import { googleCalendarHandler } from "./providers/google-calendar-handler";
import { googleDocsHandler } from "./providers/google-docs-handler";
import { googleDriveHandler } from "./providers/google-drive-handler";
import { googleMeetHandler } from "./providers/google-meet-handler";
import { googleSheetsHandler } from "./providers/google-sheets-handler";
import { linearHandler } from "./providers/linear-handler";
import { mailchimpHandler } from "./providers/mailchimp-handler";
import { mercuryHandler } from "./providers/mercury-handler";
import { mondayHandler } from "./providers/monday-handler";
import { neonHandler } from "./providers/neon-handler";
import { notionHandler } from "./providers/notion-handler";
import { outlookCalendarHandler } from "./providers/outlook-calendar-handler";
import { outlookMailHandler } from "./providers/outlook-mail-handler";
import { redditHandler } from "./providers/reddit-handler";
import { intervalsIcuHandler } from "./providers/intervals-icu-handler";
import { sentryHandler } from "./providers/sentry-handler";
import { slackHandler } from "./providers/slack-handler";
import { stravaHandler } from "./providers/strava-handler";
import { stripeHandler } from "./providers/stripe-handler";
import { todoistHandler } from "./providers/todoist-handler";
import { vercelHandler } from "./providers/vercel-handler";
import { webflowHandler } from "./providers/webflow-handler";
import { supabaseHandler } from "./providers/supabase-handler";
import { metaAdsHandler } from "./providers/meta-ads-handler";
import { posthogHandler } from "./providers/posthog-handler";
import { spotifyHandler } from "./providers/spotify-handler";
import { xHandler } from "./providers/x-handler";
import { xeroHandler } from "./providers/xero-handler";
import { zoomHandler } from "./providers/zoom-handler";
import { testOauthHandler } from "./providers/test-oauth-handler";

export type {
  AuthUrlResult,
  OAuthAuthorizeArgs,
  OAuthExchangeArgs,
  OAuthRefreshArgs,
  OAuthRefreshResult,
  OAuthTokenResult,
};
export type { ProviderEnv };
export {
  buildProviderAuthUrl,
  exchangeProviderCode,
  providerEnvFromObject,
  providerSupportsRefresh,
  refreshProviderToken,
};

export const PROVIDER_HANDLERS = {
  ahrefs: ahrefsHandler,
  airtable: airtableHandler,
  asana: asanaHandler,
  canva: canvaHandler,
  close: closeHandler,
  deel: deelHandler,
  docusign: docusignHandler,
  dropbox: dropboxHandler,
  figma: figmaHandler,
  "garmin-connect": garminConnectHandler,
  gumroad: gumroadHandler,
  github: githubHandler,
  gmail: gmailHandler,
  hubspot: hubspotHandler,
  "google-ads": googleAdsHandler,
  "google-calendar": googleCalendarHandler,
  "google-docs": googleDocsHandler,
  "google-drive": googleDriveHandler,
  "google-meet": googleMeetHandler,
  "google-sheets": googleSheetsHandler,
  linear: linearHandler,
  mailchimp: mailchimpHandler,
  mercury: mercuryHandler,
  monday: mondayHandler,
  neon: neonHandler,
  notion: notionHandler,
  "outlook-calendar": outlookCalendarHandler,
  "outlook-mail": outlookMailHandler,
  reddit: redditHandler,
  "intervals-icu": intervalsIcuHandler,
  sentry: sentryHandler,
  slack: slackHandler,
  strava: stravaHandler,
  stripe: stripeHandler,
  todoist: todoistHandler,
  vercel: vercelHandler,
  webflow: webflowHandler,
  supabase: supabaseHandler,
  "meta-ads": metaAdsHandler,
  posthog: posthogHandler,
  spotify: spotifyHandler,
  x: xHandler,
  xero: xeroHandler,
  zoom: zoomHandler,
  "test-oauth": testOauthHandler,
} satisfies Record<OAuthConnectorType, ProviderHandler>;

export type ConnectorOAuthProviderHandler = ProviderHandler;

export function isOAuthConnectorType(type: string): type is OAuthConnectorType {
  return Object.hasOwn(PROVIDER_HANDLERS, type);
}

export function getConnectorOAuthProviderHandler(
  type: string,
): ConnectorOAuthProviderHandler | undefined {
  if (!isOAuthConnectorType(type)) {
    return undefined;
  }
  return PROVIDER_HANDLERS[type];
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
