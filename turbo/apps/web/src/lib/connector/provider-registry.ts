import { type ConnectorType } from "@vm0/core";
import { type Env } from "../../env";
import {
  type AuthUrlResult,
  type OAuthTokenResult,
  type ProviderHandler,
} from "./provider-types";
import { airtableHandler } from "./providers/airtable-handler";
import { canvaHandler } from "./providers/canva-handler";
import { deelHandler } from "./providers/deel-handler";
import { docusignHandler } from "./providers/docusign-handler";
import { dropboxHandler } from "./providers/dropbox-handler";
import { figmaHandler } from "./providers/figma-handler";
import { garminConnectHandler } from "./providers/garmin-connect-handler";
import { githubHandler } from "./providers/github-handler";
import { hubspotHandler } from "./providers/hubspot-handler";
import { gmailHandler } from "./providers/gmail-handler";
import { googleCalendarHandler } from "./providers/google-calendar-handler";
import { googleDocsHandler } from "./providers/google-docs-handler";
import { googleDriveHandler } from "./providers/google-drive-handler";
import { googleSheetsHandler } from "./providers/google-sheets-handler";
import { linearHandler } from "./providers/linear-handler";
import { mercuryHandler } from "./providers/mercury-handler";
import { mondayHandler } from "./providers/monday-handler";
import { neonHandler } from "./providers/neon-handler";
import { notionHandler } from "./providers/notion-handler";
import { redditHandler } from "./providers/reddit-handler";
import { slackHandler } from "./providers/slack-handler";
import { stravaHandler } from "./providers/strava-handler";
import { stripeHandler } from "./providers/stripe-handler";
import { intervalsIcuHandler } from "./providers/intervals-icu-handler";
import { sentryHandler } from "./providers/sentry-handler";
import { vercelHandler } from "./providers/vercel-handler";
import { xHandler } from "./providers/x-handler";
import { supabaseHandler } from "./providers/supabase-handler";
import { todoistHandler } from "./providers/todoist-handler";
import { webflowHandler } from "./providers/webflow-handler";
import { metaAdsHandler } from "./providers/meta-ads-handler";
import { xeroHandler } from "./providers/xero-handler";

export type { AuthUrlResult, OAuthTokenResult };

export const PROVIDER_HANDLERS: Record<
  Exclude<ConnectorType, "computer">,
  ProviderHandler
> = {
  airtable: airtableHandler,
  canva: canvaHandler,
  deel: deelHandler,
  docusign: docusignHandler,
  dropbox: dropboxHandler,
  figma: figmaHandler,
  "garmin-connect": garminConnectHandler,
  github: githubHandler,
  gmail: gmailHandler,
  hubspot: hubspotHandler,
  "google-calendar": googleCalendarHandler,
  "google-docs": googleDocsHandler,
  "google-drive": googleDriveHandler,
  "google-sheets": googleSheetsHandler,
  linear: linearHandler,
  mercury: mercuryHandler,
  monday: mondayHandler,
  neon: neonHandler,
  notion: notionHandler,
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
  x: xHandler,
  xero: xeroHandler,
};

/**
 * Returns connector types whose OAuth credentials (or equivalent) are
 * configured in the current environment.
 */
export function getConfiguredConnectorTypes(currentEnv: Env): ConnectorType[] {
  const configured: ConnectorType[] = [];

  for (const [type, handler] of Object.entries(PROVIDER_HANDLERS)) {
    if (
      handler.getClientId(currentEnv) &&
      handler.getClientSecret(currentEnv)
    ) {
      configured.push(type as ConnectorType);
    }
  }

  // computer connector: no OAuth — uses ngrok credentials instead
  if (currentEnv.NGROK_API_KEY && currentEnv.NGROK_COMPUTER_CONNECTOR_DOMAIN) {
    configured.push("computer");
  }

  return configured;
}
