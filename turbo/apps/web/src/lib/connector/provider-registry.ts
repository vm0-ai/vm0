import { type ConnectorType, getConnectorDefaultAuthMethod } from "@vm0/core";
import { type Env } from "../../env";
import {
  type AuthUrlResult,
  type OAuthTokenResult,
  type ProviderHandler,
} from "./provider-types";
import { agentmailHandler } from "./providers/agentmail-handler";
import { ahrefsHandler } from "./providers/ahrefs-handler";
import { airtableHandler } from "./providers/airtable-handler";
import { apifyHandler } from "./providers/apify-handler";
import { axiomHandler } from "./providers/axiom-handler";
import { asanaHandler } from "./providers/asana-handler";
import { brightDataHandler } from "./providers/bright-data-handler";
import { browserbaseHandler } from "./providers/browserbase-handler";
import { browserlessHandler } from "./providers/browserless-handler";
import { canvaHandler } from "./providers/canva-handler";
import { chatwootHandler } from "./providers/chatwoot-handler";
import { closeHandler } from "./providers/close-handler";
import { deelHandler } from "./providers/deel-handler";
import { docusignHandler } from "./providers/docusign-handler";
import { dropboxHandler } from "./providers/dropbox-handler";
import { elevenlabsHandler } from "./providers/elevenlabs-handler";
import { falHandler } from "./providers/fal-handler";
import { figmaHandler } from "./providers/figma-handler";
import { firecrawlHandler } from "./providers/firecrawl-handler";
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
import { minimaxHandler } from "./providers/minimax-handler";
import { mondayHandler } from "./providers/monday-handler";
import { neonHandler } from "./providers/neon-handler";
import { notionHandler } from "./providers/notion-handler";
import { openaiHandler } from "./providers/openai-handler";
import { redditHandler } from "./providers/reddit-handler";
import { slackHandler } from "./providers/slack-handler";
import { stravaHandler } from "./providers/strava-handler";
import { stripeHandler } from "./providers/stripe-handler";
import { intervalsIcuHandler } from "./providers/intervals-icu-handler";
import { sentryHandler } from "./providers/sentry-handler";
import { vercelHandler } from "./providers/vercel-handler";
import { xHandler } from "./providers/x-handler";
import { supabaseHandler } from "./providers/supabase-handler";
import { mailchimpHandler } from "./providers/mailchimp-handler";
import { todoistHandler } from "./providers/todoist-handler";
import { webflowHandler } from "./providers/webflow-handler";
import { outlookCalendarHandler } from "./providers/outlook-calendar-handler";
import { outlookMailHandler } from "./providers/outlook-mail-handler";
import { metaAdsHandler } from "./providers/meta-ads-handler";
import { posthogHandler } from "./providers/posthog-handler";
import { pdf4meHandler } from "./providers/pdf4me-handler";
import { perplexityHandler } from "./providers/perplexity-handler";
import { plausibleHandler } from "./providers/plausible-handler";
import { productlaneHandler } from "./providers/productlane-handler";
import { resendHandler } from "./providers/resend-handler";
import { scrapeninjaHandler } from "./providers/scrapeninja-handler";
import { similarwebHandler } from "./providers/similarweb-handler";
import { xeroHandler } from "./providers/xero-handler";

export type { AuthUrlResult, OAuthTokenResult };

export const PROVIDER_HANDLERS: Record<
  Exclude<ConnectorType, "computer">,
  ProviderHandler
> = {
  agentmail: agentmailHandler,
  ahrefs: ahrefsHandler,
  airtable: airtableHandler,
  apify: apifyHandler,
  axiom: axiomHandler,
  asana: asanaHandler,
  "bright-data": brightDataHandler,
  browserbase: browserbaseHandler,
  browserless: browserlessHandler,
  canva: canvaHandler,
  chatwoot: chatwootHandler,
  close: closeHandler,
  deel: deelHandler,
  docusign: docusignHandler,
  dropbox: dropboxHandler,
  elevenlabs: elevenlabsHandler,
  fal: falHandler,
  figma: figmaHandler,
  firecrawl: firecrawlHandler,
  "garmin-connect": garminConnectHandler,
  github: githubHandler,
  gmail: gmailHandler,
  hubspot: hubspotHandler,
  "google-calendar": googleCalendarHandler,
  "google-docs": googleDocsHandler,
  "google-drive": googleDriveHandler,
  "google-sheets": googleSheetsHandler,
  linear: linearHandler,
  mailchimp: mailchimpHandler,
  mercury: mercuryHandler,
  minimax: minimaxHandler,
  monday: mondayHandler,
  neon: neonHandler,
  notion: notionHandler,
  openai: openaiHandler,
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
  pdf4me: pdf4meHandler,
  perplexity: perplexityHandler,
  plausible: plausibleHandler,
  productlane: productlaneHandler,
  resend: resendHandler,
  scrapeninja: scrapeninjaHandler,
  similarweb: similarwebHandler,
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
    const connectorType = type as ConnectorType;
    if (
      handler.getClientId(currentEnv) &&
      handler.getClientSecret(currentEnv)
    ) {
      configured.push(connectorType);
    } else if (getConnectorDefaultAuthMethod(connectorType) === "api-token") {
      configured.push(connectorType);
    }
  }

  // computer connector: no OAuth — uses ngrok credentials instead
  if (currentEnv.NGROK_API_KEY && currentEnv.NGROK_COMPUTER_CONNECTOR_DOMAIN) {
    configured.push("computer");
  }

  return configured;
}
