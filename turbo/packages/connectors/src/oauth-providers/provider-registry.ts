import type { ConnectorType } from "@vm0/connectors/connectors";
import { getConfiguredConnectorTypes as getConfiguredConnectorTypesFromEnv } from "@vm0/connectors/connector-utils";
import {
  type AuthUrlResult,
  type OAuthTokenResult,
  type ProviderHandler,
  type ProviderEnv,
} from "./provider-types";
import { agentmailHandler } from "./providers/agentmail-handler";
import { amplitudeHandler } from "./providers/amplitude-handler";
import { anthropicManagedAgentsHandler } from "./providers/anthropic-managed-agents-handler";
import { ahrefsHandler } from "./providers/ahrefs-handler";
import { agoraHandler } from "./providers/agora-handler";
import { airtableHandler } from "./providers/airtable-handler";
import { apolloHandler } from "./providers/apollo-handler";
import { apifyHandler } from "./providers/apify-handler";
import { pikaHandler } from "./providers/pika-handler";
import { axiomHandler } from "./providers/axiom-handler";
import { asanaHandler } from "./providers/asana-handler";
import { attioHandler } from "./providers/attio-handler";
import { atlassianHandler } from "./providers/atlassian-handler";
import { bentomlHandler } from "./providers/bentoml-handler";
import { bitrixHandler } from "./providers/bitrix-handler";
import { braveSearchHandler } from "./providers/brave-search-handler";
import { brevoHandler } from "./providers/brevo-handler";
import { brightDataHandler } from "./providers/bright-data-handler";
import { browserbaseHandler } from "./providers/browserbase-handler";
import { browserUseHandler } from "./providers/browser-use-handler";
import { browserlessHandler } from "./providers/browserless-handler";
import { bufferHandler } from "./providers/buffer-handler";
import { calComHandler } from "./providers/cal-com-handler";
import { calendlyHandler } from "./providers/calendly-handler";
import { canvaHandler } from "./providers/canva-handler";
import { chatwootHandler } from "./providers/chatwoot-handler";
import { clickupHandler } from "./providers/clickup-handler";
import { cloudflareHandler } from "./providers/cloudflare-handler";
import { cloudinaryHandler } from "./providers/cloudinary-handler";
import { closeHandler } from "./providers/close-handler";
import { codaHandler } from "./providers/coda-handler";
import { cronlyticHandler } from "./providers/cronlytic-handler";
import { customerIoHandler } from "./providers/customer-io-handler";
import { deelHandler } from "./providers/deel-handler";
import { discordHandler } from "./providers/discord-handler";
import { discordWebhookHandler } from "./providers/discord-webhook-handler";
import { deepseekHandler } from "./providers/deepseek-handler";
import { doubaoHandler } from "./providers/doubao-handler";
import { difyHandler } from "./providers/dify-handler";
import { devtoHandler } from "./providers/devto-handler";
import { dopplerHandler } from "./providers/doppler-handler";
import { infisicalHandler } from "./providers/infisical-handler";
import { docusignHandler } from "./providers/docusign-handler";
import { db9Handler } from "./providers/db9-handler";
import { drive9Handler } from "./providers/drive9-handler";
import { dropboxHandler } from "./providers/dropbox-handler";
import { dropboxSignHandler } from "./providers/dropbox-sign-handler";
import { duffelHandler } from "./providers/duffel-handler";
import { e2bHandler } from "./providers/e2b-handler";
import { elevenlabsHandler } from "./providers/elevenlabs-handler";
import { etsyHandler } from "./providers/etsy-handler";
import { exaHandler } from "./providers/exa-handler";
import { exploriumHandler } from "./providers/explorium-handler";
import { falHandler } from "./providers/fal-handler";
import { figmaHandler } from "./providers/figma-handler";
import { firefliesHandler } from "./providers/fireflies-handler";
import { firecrawlHandler } from "./providers/firecrawl-handler";
import { freshdeskHandler } from "./providers/freshdesk-handler";
import { gammaHandler } from "./providers/gamma-handler";
import { garminConnectHandler } from "./providers/garmin-connect-handler";
import { geminiHandler } from "./providers/gemini-handler";
import { gitlabHandler } from "./providers/gitlab-handler";
import { granolaHandler } from "./providers/granola-handler";
import { greenhouseHandler } from "./providers/greenhouse-handler";
import { groqHandler } from "./providers/groq-handler";
import { gumroadHandler } from "./providers/gumroad-handler";
import { githubHandler } from "./providers/github-handler";
import { heygenHandler } from "./providers/heygen-handler";
import { heliconeHandler } from "./providers/helicone-handler";
import { huggingFaceHandler } from "./providers/hugging-face-handler";
import { humeHandler } from "./providers/hume-handler";
import { htmlcsstoimageHandler } from "./providers/htmlcsstoimage-handler";
import { hubspotHandler } from "./providers/hubspot-handler";
import { imgurHandler } from "./providers/imgur-handler";
import { instagramHandler } from "./providers/instagram-handler";
import { gmailHandler } from "./providers/gmail-handler";
import { googleAdsHandler } from "./providers/google-ads-handler";
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
import { klaviyoHandler } from "./providers/klaviyo-handler";
import { kommoHandler } from "./providers/kommo-handler";
import { larkHandler } from "./providers/lark-handler";
import { langfuseHandler } from "./providers/langfuse-handler";
import { langsmithHandler } from "./providers/langsmith-handler";
import { lineHandler } from "./providers/line-handler";
import { linearHandler } from "./providers/linear-handler";
import { localBrowserHandler } from "./providers/local-browser-handler";
import { loopsHandler } from "./providers/loops-handler";
import { lumaHandler } from "./providers/luma-handler";
import { lumaAiHandler } from "./providers/luma-ai-handler";
import { mailsacHandler } from "./providers/mailsac-handler";
import { makeHandler } from "./providers/make-handler";
import { manusHandler } from "./providers/manus-handler";
import { mem0Handler } from "./providers/mem0-handler";
import { supermemoryHandler } from "./providers/supermemory-handler";
import { metabaseHandler } from "./providers/metabase-handler";
import { mossHandler } from "./providers/moss-handler";
import { mercuryHandler } from "./providers/mercury-handler";
import { minioHandler } from "./providers/minio-handler";
import { minimaxHandler } from "./providers/minimax-handler";
import { miroHandler } from "./providers/miro-handler";
import { mixpanelHandler } from "./providers/mixpanel-handler";
import { mondayHandler } from "./providers/monday-handler";
import { msg9Handler } from "./providers/msg9-handler";
import { neonHandler } from "./providers/neon-handler";
import { notionHandler } from "./providers/notion-handler";
import { onyxHandler } from "./providers/onyx-handler";
import { openaiHandler } from "./providers/openai-handler";
import { codexOauthHandler } from "./providers/codex-oauth-handler";
import { railwayHandler } from "./providers/railway-handler";
import { railwayProjectHandler } from "./providers/railway-project-handler";
import { redditHandler } from "./providers/reddit-handler";
import { reapHandler } from "./providers/reap-handler";
import { localAgentHandler } from "./providers/local-agent-handler";
import { reporteiHandler } from "./providers/reportei-handler";
import { serpapiHandler } from "./providers/serpapi-handler";
import { runwayHandler } from "./providers/runway-handler";
import { salesforceHandler } from "./providers/salesforce-handler";
import { shopifyHandler } from "./providers/shopify-handler";
import { shortioHandler } from "./providers/shortio-handler";
import { stabilityAiHandler } from "./providers/stability-ai-handler";
import { strapiHandler } from "./providers/strapi-handler";
import { streakHandler } from "./providers/streak-handler";
import { supadataHandler } from "./providers/supadata-handler";
import { tavilyHandler } from "./providers/tavily-handler";
import { tldvHandler } from "./providers/tldv-handler";
import { togetherHandler } from "./providers/together-handler";
import { twentyHandler } from "./providers/twenty-handler";
import { typeformHandler } from "./providers/typeform-handler";
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
import { pandadocHandler } from "./providers/pandadoc-handler";
import { pdfcoHandler } from "./providers/pdfco-handler";
import { perplexityHandler } from "./providers/perplexity-handler";
import { pineconeHandler } from "./providers/pinecone-handler";
import { pipedriveHandler } from "./providers/pipedrive-handler";
import { pushinatorHandler } from "./providers/pushinator-handler";
import { plainHandler } from "./providers/plain-handler";
import { plausibleHandler } from "./providers/plausible-handler";
import { podchaserHandler } from "./providers/podchaser-handler";
import { productlaneHandler } from "./providers/productlane-handler";
import { qdrantHandler } from "./providers/qdrant-handler";
import { qiitaHandler } from "./providers/qiita-handler";
import { replicateHandler } from "./providers/replicate-handler";
import { resendHandler } from "./providers/resend-handler";
import { revenuecatHandler } from "./providers/revenuecat-handler";
import { scrapeninjaHandler } from "./providers/scrapeninja-handler";
import { similarwebHandler } from "./providers/similarweb-handler";
import { spongeHandler } from "./providers/sponge-handler";
import { spotifyHandler } from "./providers/spotify-handler";
import { workosHandler } from "./providers/workos-handler";
import { wrikeHandler } from "./providers/wrike-handler";
import { xeroHandler } from "./providers/xero-handler";
import { pdforgeHandler } from "./providers/pdforge-handler";
import { slackWebhookHandler } from "./providers/slack-webhook-handler";
import { v0Handler } from "./providers/v0-handler";
import { wixHandler } from "./providers/wix-handler";
import { zepHandler } from "./providers/zep-handler";
import { zeptomailHandler } from "./providers/zeptomail-handler";
import { zoomHandler } from "./providers/zoom-handler";
import { n8nHandler } from "./providers/n8n-handler";
import { testOauthHandler } from "./providers/test-oauth-handler";
import { wandbHandler } from "./providers/wandb-handler";
import { altium365Handler } from "./providers/altium-365-handler";
import { browserstackHandler } from "./providers/browserstack-handler";
import { sendgridHandler } from "./providers/sendgrid-handler";
import { servicenowHandler } from "./providers/servicenow-handler";
import { testrailHandler } from "./providers/testrail-handler";
import { twilioHandler } from "./providers/twilio-handler";
import { squareHandler } from "./providers/square-handler";
import { gongHandler } from "./providers/gong-handler";
import { ironcladHandler } from "./providers/ironclad-handler";
import { snowflakeHandler } from "./providers/snowflake-handler";

export type { AuthUrlResult, OAuthTokenResult };
export type { ProviderEnv };
export { providerEnvFromObject } from "./provider-types";

export const PROVIDER_HANDLERS: Record<
  Exclude<ConnectorType, "computer">,
  ProviderHandler
> = {
  agentmail: agentmailHandler,
  amplitude: amplitudeHandler,
  "anthropic-managed-agents": anthropicManagedAgentsHandler,
  ahrefs: ahrefsHandler,
  agora: agoraHandler,
  airtable: airtableHandler,
  apollo: apolloHandler,
  apify: apifyHandler,
  pika: pikaHandler,
  axiom: axiomHandler,
  asana: asanaHandler,
  attio: attioHandler,
  atlassian: atlassianHandler,
  bentoml: bentomlHandler,
  bitrix: bitrixHandler,
  "brave-search": braveSearchHandler,
  brevo: brevoHandler,
  "bright-data": brightDataHandler,
  browserbase: browserbaseHandler,
  "browser-use": browserUseHandler,
  browserless: browserlessHandler,
  buffer: bufferHandler,
  "cal-com": calComHandler,
  calendly: calendlyHandler,
  canva: canvaHandler,
  chatwoot: chatwootHandler,
  clickup: clickupHandler,
  cloudflare: cloudflareHandler,
  cloudinary: cloudinaryHandler,
  close: closeHandler,
  coda: codaHandler,
  cronlytic: cronlyticHandler,
  "customer-io": customerIoHandler,
  deel: deelHandler,
  discord: discordHandler,
  "discord-webhook": discordWebhookHandler,
  deepseek: deepseekHandler,
  doubao: doubaoHandler,
  dify: difyHandler,
  devto: devtoHandler,
  doppler: dopplerHandler,
  infisical: infisicalHandler,
  docusign: docusignHandler,
  db9: db9Handler,
  drive9: drive9Handler,
  dropbox: dropboxHandler,
  "dropbox-sign": dropboxSignHandler,
  duffel: duffelHandler,
  e2b: e2bHandler,
  elevenlabs: elevenlabsHandler,
  etsy: etsyHandler,
  exa: exaHandler,
  explorium: exploriumHandler,
  fal: falHandler,
  figma: figmaHandler,
  fireflies: firefliesHandler,
  firecrawl: firecrawlHandler,
  freshdesk: freshdeskHandler,
  gamma: gammaHandler,
  "garmin-connect": garminConnectHandler,
  gemini: geminiHandler,
  gitlab: gitlabHandler,
  granola: granolaHandler,
  greenhouse: greenhouseHandler,
  groq: groqHandler,
  gumroad: gumroadHandler,
  github: githubHandler,
  gmail: gmailHandler,
  heygen: heygenHandler,
  helicone: heliconeHandler,
  "hugging-face": huggingFaceHandler,
  hume: humeHandler,
  htmlcsstoimage: htmlcsstoimageHandler,
  hubspot: hubspotHandler,
  imgur: imgurHandler,
  instantly: instantlyHandler,
  instagram: instagramHandler,
  "google-ads": googleAdsHandler,
  "google-calendar": googleCalendarHandler,
  "google-docs": googleDocsHandler,
  "google-drive": googleDriveHandler,
  "google-meet": googleMeetHandler,
  "google-sheets": googleSheetsHandler,
  lark: larkHandler,
  langfuse: langfuseHandler,
  langsmith: langsmithHandler,
  line: lineHandler,
  linear: linearHandler,
  loops: loopsHandler,
  luma: lumaHandler,
  "luma-ai": lumaAiHandler,
  mailsac: mailsacHandler,
  make: makeHandler,
  manus: manusHandler,
  mem0: mem0Handler,
  supermemory: supermemoryHandler,
  metabase: metabaseHandler,
  moss: mossHandler,
  mailchimp: mailchimpHandler,
  mercury: mercuryHandler,
  minio: minioHandler,
  minimax: minimaxHandler,
  miro: miroHandler,
  mixpanel: mixpanelHandler,
  monday: mondayHandler,
  msg9: msg9Handler,
  neon: neonHandler,
  notion: notionHandler,
  onyx: onyxHandler,
  openai: openaiHandler,
  "codex-oauth": codexOauthHandler,
  "outlook-calendar": outlookCalendarHandler,
  "outlook-mail": outlookMailHandler,
  railway: railwayHandler,
  "railway-project": railwayProjectHandler,
  reddit: redditHandler,
  reap: reapHandler,
  "local-browser": localBrowserHandler,
  "local-agent": localAgentHandler,
  reportei: reporteiHandler,
  serpapi: serpapiHandler,
  intercom: intercomHandler,
  jam: jamHandler,
  jira: jiraHandler,
  jotform: jotformHandler,
  klaviyo: klaviyoHandler,
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
  pandadoc: pandadocHandler,
  pdf4me: pdf4meHandler,
  pdfco: pdfcoHandler,
  perplexity: perplexityHandler,
  pinecone: pineconeHandler,
  pipedrive: pipedriveHandler,
  plain: plainHandler,
  plausible: plausibleHandler,
  podchaser: podchaserHandler,
  productlane: productlaneHandler,
  pushinator: pushinatorHandler,
  qdrant: qdrantHandler,
  qiita: qiitaHandler,
  replicate: replicateHandler,
  resend: resendHandler,
  revenuecat: revenuecatHandler,
  scrapeninja: scrapeninjaHandler,
  similarweb: similarwebHandler,
  sponge: spongeHandler,
  spotify: spotifyHandler,
  workos: workosHandler,
  wrike: wrikeHandler,
  x: xHandler,
  xero: xeroHandler,
  zep: zepHandler,
  zeptomail: zeptomailHandler,
  runway: runwayHandler,
  salesforce: salesforceHandler,
  shopify: shopifyHandler,
  shortio: shortioHandler,
  "stability-ai": stabilityAiHandler,
  streak: streakHandler,
  supadata: supadataHandler,
  tavily: tavilyHandler,
  tldv: tldvHandler,
  together: togetherHandler,
  twenty: twentyHandler,
  typeform: typeformHandler,
  youtube: youtubeHandler,
  zapier: zapierHandler,
  zapsign: zapsignHandler,
  zendesk: zendeskHandler,
  zoom: zoomHandler,
  pdforge: pdforgeHandler,
  "slack-webhook": slackWebhookHandler,
  v0: v0Handler,
  wix: wixHandler,
  n8n: n8nHandler,
  "test-oauth": testOauthHandler,
  wandb: wandbHandler,
  "altium-365": altium365Handler,
  browserstack: browserstackHandler,
  sendgrid: sendgridHandler,
  servicenow: servicenowHandler,
  testrail: testrailHandler,
  twilio: twilioHandler,
  square: squareHandler,
  gong: gongHandler,
  ironclad: ironcladHandler,
  snowflake: snowflakeHandler,
};

/**
 * Returns connector types whose OAuth credentials (or equivalent) are
 * configured in the current environment.
 */
export function getConfiguredConnectorTypes(
  currentEnv: ProviderEnv,
): ConnectorType[] {
  return getConfiguredConnectorTypesFromEnv((name) => {
    const value = currentEnv[name];
    return typeof value === "string" ? value : undefined;
  });
}
