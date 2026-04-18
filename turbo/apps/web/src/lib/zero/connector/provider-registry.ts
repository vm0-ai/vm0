import { type ConnectorType, getConnectorDefaultAuthMethod } from "@vm0/core";
import { type Env } from "../../../env";
import {
  type AuthUrlResult,
  type OAuthTokenResult,
  type ProviderHandler,
} from "./provider-types";
import { agentmailHandler } from "./providers/agentmail-handler";
import { agentphoneHandler } from "./providers/agentphone-handler";
import { anthropicManagedAgentsHandler } from "./providers/anthropic-managed-agents-handler";
import { ahrefsHandler } from "./providers/ahrefs-handler";
import { airtableHandler } from "./providers/airtable-handler";
import { apolloHandler } from "./providers/apollo-handler";
import { apifyHandler } from "./providers/apify-handler";
import { pikaHandler } from "./providers/pika-handler";
import { axiomHandler } from "./providers/axiom-handler";
import { asanaHandler } from "./providers/asana-handler";
import { atlassianHandler } from "./providers/atlassian-handler";
import { bitrixHandler } from "./providers/bitrix-handler";
import { braveSearchHandler } from "./providers/brave-search-handler";
import { brevoHandler } from "./providers/brevo-handler";
import { brightDataHandler } from "./providers/bright-data-handler";
import { browserbaseHandler } from "./providers/browserbase-handler";
import { browserlessHandler } from "./providers/browserless-handler";
import { calComHandler } from "./providers/cal-com-handler";
import { calendlyHandler } from "./providers/calendly-handler";
import { canvaHandler } from "./providers/canva-handler";
import { chatwootHandler } from "./providers/chatwoot-handler";
import { clickupHandler } from "./providers/clickup-handler";
import { cloudflareHandler } from "./providers/cloudflare-handler";
import { cloudinaryHandler } from "./providers/cloudinary-handler";
import { closeHandler } from "./providers/close-handler";
import { cronlyticHandler } from "./providers/cronlytic-handler";
import { customerIoHandler } from "./providers/customer-io-handler";
import { deelHandler } from "./providers/deel-handler";
import { discordHandler } from "./providers/discord-handler";
import { discordWebhookHandler } from "./providers/discord-webhook-handler";
import { deepseekHandler } from "./providers/deepseek-handler";
import { difyHandler } from "./providers/dify-handler";
import { devtoHandler } from "./providers/devto-handler";
import { dopplerHandler } from "./providers/doppler-handler";
import { infisicalHandler } from "./providers/infisical-handler";
import { docusignHandler } from "./providers/docusign-handler";
import { db9Handler } from "./providers/db9-handler";
import { drive9Handler } from "./providers/drive9-handler";
import { dropboxHandler } from "./providers/dropbox-handler";
import { elevenlabsHandler } from "./providers/elevenlabs-handler";
import { exploriumHandler } from "./providers/explorium-handler";
import { falHandler } from "./providers/fal-handler";
import { figmaHandler } from "./providers/figma-handler";
import { firefliesHandler } from "./providers/fireflies-handler";
import { firecrawlHandler } from "./providers/firecrawl-handler";
import { gammaHandler } from "./providers/gamma-handler";
import { garminConnectHandler } from "./providers/garmin-connect-handler";
import { gitlabHandler } from "./providers/gitlab-handler";
import { granolaHandler } from "./providers/granola-handler";
import { githubHandler } from "./providers/github-handler";
import { heygenHandler } from "./providers/heygen-handler";
import { huggingFaceHandler } from "./providers/hugging-face-handler";
import { humeHandler } from "./providers/hume-handler";
import { htmlcsstoimageHandler } from "./providers/htmlcsstoimage-handler";
import { hubspotHandler } from "./providers/hubspot-handler";
import { imgurHandler } from "./providers/imgur-handler";
import { instagramHandler } from "./providers/instagram-handler";
import { gmailHandler } from "./providers/gmail-handler";
import { googleCalendarHandler } from "./providers/google-calendar-handler";
import { googleDocsHandler } from "./providers/google-docs-handler";
import { googleDriveHandler } from "./providers/google-drive-handler";
import { googleMeetHandler } from "./providers/google-meet-handler";
import { googleSheetsHandler } from "./providers/google-sheets-handler";
import { instantlyHandler } from "./providers/instantly-handler";
import { intercomHandler } from "./providers/intercom-handler";
import { jamHandler } from "./providers/jam-handler";
import { jiraHandler } from "./providers/jira-handler";
import { jotformHandler } from "./providers/jotform-handler";
import { kommoHandler } from "./providers/kommo-handler";
import { larkHandler } from "./providers/lark-handler";
import { lineHandler } from "./providers/line-handler";
import { linearHandler } from "./providers/linear-handler";
import { loopsHandler } from "./providers/loops-handler";
import { mailsacHandler } from "./providers/mailsac-handler";
import { makeHandler } from "./providers/make-handler";
import { manusHandler } from "./providers/manus-handler";
import { metabaseHandler } from "./providers/metabase-handler";
import { mercuryHandler } from "./providers/mercury-handler";
import { minioHandler } from "./providers/minio-handler";
import { minimaxHandler } from "./providers/minimax-handler";
import { mondayHandler } from "./providers/monday-handler";
import { msg9Handler } from "./providers/msg9-handler";
import { neonHandler } from "./providers/neon-handler";
import { notionHandler } from "./providers/notion-handler";
import { openaiHandler } from "./providers/openai-handler";
import { redditHandler } from "./providers/reddit-handler";
import { reporteiHandler } from "./providers/reportei-handler";
import { serpapiHandler } from "./providers/serpapi-handler";
import { runwayHandler } from "./providers/runway-handler";
import { salesforceHandler } from "./providers/salesforce-handler";
import { shopifyHandler } from "./providers/shopify-handler";
import { shortioHandler } from "./providers/shortio-handler";
import { strapiHandler } from "./providers/strapi-handler";
import { streakHandler } from "./providers/streak-handler";
import { supadataHandler } from "./providers/supadata-handler";
import { tavilyHandler } from "./providers/tavily-handler";
import { tldvHandler } from "./providers/tldv-handler";
import { twentyHandler } from "./providers/twenty-handler";
import { youtubeHandler } from "./providers/youtube-handler";
import { zapierHandler } from "./providers/zapier-handler";
import { zapsignHandler } from "./providers/zapsign-handler";
import { zendeskHandler } from "./providers/zendesk-handler";
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
import { prismaPostgresHandler } from "./providers/prisma-postgres-handler";
import { pdf4meHandler } from "./providers/pdf4me-handler";
import { pdfcoHandler } from "./providers/pdfco-handler";
import { perplexityHandler } from "./providers/perplexity-handler";
import { pushinatorHandler } from "./providers/pushinator-handler";
import { plainHandler } from "./providers/plain-handler";
import { plausibleHandler } from "./providers/plausible-handler";
import { podchaserHandler } from "./providers/podchaser-handler";
import { productlaneHandler } from "./providers/productlane-handler";
import { qdrantHandler } from "./providers/qdrant-handler";
import { qiitaHandler } from "./providers/qiita-handler";
import { resendHandler } from "./providers/resend-handler";
import { revenuecatHandler } from "./providers/revenuecat-handler";
import { scrapeninjaHandler } from "./providers/scrapeninja-handler";
import { similarwebHandler } from "./providers/similarweb-handler";
import { spotifyHandler } from "./providers/spotify-handler";
import { wrikeHandler } from "./providers/wrike-handler";
import { xeroHandler } from "./providers/xero-handler";
import { pdforgeHandler } from "./providers/pdforge-handler";
import { slackWebhookHandler } from "./providers/slack-webhook-handler";
import { v0Handler } from "./providers/v0-handler";
import { wixHandler } from "./providers/wix-handler";
import { zeptomailHandler } from "./providers/zeptomail-handler";
import { testOauthHandler } from "./providers/test-oauth-handler";

export type { AuthUrlResult, OAuthTokenResult };

export const PROVIDER_HANDLERS: Record<
  Exclude<ConnectorType, "computer">,
  ProviderHandler
> = {
  agentmail: agentmailHandler,
  agentphone: agentphoneHandler,
  "anthropic-managed-agents": anthropicManagedAgentsHandler,
  ahrefs: ahrefsHandler,
  airtable: airtableHandler,
  apollo: apolloHandler,
  apify: apifyHandler,
  pika: pikaHandler,
  axiom: axiomHandler,
  asana: asanaHandler,
  atlassian: atlassianHandler,
  bitrix: bitrixHandler,
  "brave-search": braveSearchHandler,
  brevo: brevoHandler,
  "bright-data": brightDataHandler,
  browserbase: browserbaseHandler,
  browserless: browserlessHandler,
  "cal-com": calComHandler,
  calendly: calendlyHandler,
  canva: canvaHandler,
  chatwoot: chatwootHandler,
  clickup: clickupHandler,
  cloudflare: cloudflareHandler,
  cloudinary: cloudinaryHandler,
  close: closeHandler,
  cronlytic: cronlyticHandler,
  "customer-io": customerIoHandler,
  deel: deelHandler,
  discord: discordHandler,
  "discord-webhook": discordWebhookHandler,
  deepseek: deepseekHandler,
  dify: difyHandler,
  devto: devtoHandler,
  doppler: dopplerHandler,
  infisical: infisicalHandler,
  docusign: docusignHandler,
  db9: db9Handler,
  drive9: drive9Handler,
  dropbox: dropboxHandler,
  elevenlabs: elevenlabsHandler,
  explorium: exploriumHandler,
  fal: falHandler,
  figma: figmaHandler,
  fireflies: firefliesHandler,
  firecrawl: firecrawlHandler,
  gamma: gammaHandler,
  "garmin-connect": garminConnectHandler,
  gitlab: gitlabHandler,
  granola: granolaHandler,
  github: githubHandler,
  gmail: gmailHandler,
  heygen: heygenHandler,
  "hugging-face": huggingFaceHandler,
  hume: humeHandler,
  htmlcsstoimage: htmlcsstoimageHandler,
  hubspot: hubspotHandler,
  imgur: imgurHandler,
  instantly: instantlyHandler,
  instagram: instagramHandler,
  "google-calendar": googleCalendarHandler,
  "google-docs": googleDocsHandler,
  "google-drive": googleDriveHandler,
  "google-meet": googleMeetHandler,
  "google-sheets": googleSheetsHandler,
  lark: larkHandler,
  line: lineHandler,
  linear: linearHandler,
  loops: loopsHandler,
  mailsac: mailsacHandler,
  make: makeHandler,
  manus: manusHandler,
  metabase: metabaseHandler,
  mailchimp: mailchimpHandler,
  mercury: mercuryHandler,
  minio: minioHandler,
  minimax: minimaxHandler,
  monday: mondayHandler,
  msg9: msg9Handler,
  neon: neonHandler,
  notion: notionHandler,
  openai: openaiHandler,
  "outlook-calendar": outlookCalendarHandler,
  "outlook-mail": outlookMailHandler,
  reddit: redditHandler,
  reportei: reporteiHandler,
  serpapi: serpapiHandler,
  intercom: intercomHandler,
  jam: jamHandler,
  jira: jiraHandler,
  jotform: jotformHandler,
  kommo: kommoHandler,
  "intervals-icu": intervalsIcuHandler,
  sentry: sentryHandler,
  slack: slackHandler,
  strapi: strapiHandler,
  strava: stravaHandler,
  stripe: stripeHandler,
  todoist: todoistHandler,
  vercel: vercelHandler,
  webflow: webflowHandler,
  supabase: supabaseHandler,
  "meta-ads": metaAdsHandler,
  posthog: posthogHandler,
  "prisma-postgres": prismaPostgresHandler,
  pdf4me: pdf4meHandler,
  pdfco: pdfcoHandler,
  perplexity: perplexityHandler,
  plain: plainHandler,
  plausible: plausibleHandler,
  podchaser: podchaserHandler,
  productlane: productlaneHandler,
  pushinator: pushinatorHandler,
  qdrant: qdrantHandler,
  qiita: qiitaHandler,
  resend: resendHandler,
  revenuecat: revenuecatHandler,
  scrapeninja: scrapeninjaHandler,
  similarweb: similarwebHandler,
  spotify: spotifyHandler,
  wrike: wrikeHandler,
  x: xHandler,
  xero: xeroHandler,
  zeptomail: zeptomailHandler,
  runway: runwayHandler,
  salesforce: salesforceHandler,
  shopify: shopifyHandler,
  shortio: shortioHandler,
  streak: streakHandler,
  supadata: supadataHandler,
  tavily: tavilyHandler,
  tldv: tldvHandler,
  twenty: twentyHandler,
  youtube: youtubeHandler,
  zapier: zapierHandler,
  zapsign: zapsignHandler,
  zendesk: zendeskHandler,
  pdforge: pdforgeHandler,
  "slack-webhook": slackWebhookHandler,
  v0: v0Handler,
  wix: wixHandler,
  "test-oauth": testOauthHandler,
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
