/**
 * Builtin firewall configs registry.
 *
 * Generated configs are imported here and exposed as a lookup map.
 * The firewall loader checks this registry before falling back to
 * remote GitHub fetch.
 */

import type { FirewallConfig } from "../contracts/firewalls";
import type { ConnectorType } from "../contracts/connectors";
import { getConnectorEnvironmentMapping } from "../contracts/connectors";
import { agentmailFirewall } from "./agentmail.generated";
import { ahrefsFirewall } from "./ahrefs.generated";
import { airtableFirewall } from "./airtable.generated";
import { apifyFirewall } from "./apify.generated";
import { asanaFirewall } from "./asana.generated";
import { atlassianFirewall } from "./atlassian.generated";
import { axiomFirewall } from "./axiom.generated";
import { braveSearchFirewall } from "./brave-search.generated";
import { brevoFirewall } from "./brevo.generated";
import { brightDataFirewall } from "./bright-data.generated";
import { browserbaseFirewall } from "./browserbase.generated";
import { browserlessFirewall } from "./browserless.generated";
import { calComFirewall } from "./cal-com.generated";
import { calendlyFirewall } from "./calendly.generated";
import { canvaFirewall } from "./canva.generated";
import { clickupFirewall } from "./clickup.generated";
import { closeFirewall } from "./close.generated";
import { cloudflareFirewall } from "./cloudflare.generated";
import { cronlyticFirewall } from "./cronlytic.generated";
import { customerIoFirewall } from "./customer-io.generated";
import { deepseekFirewall } from "./deepseek.generated";
import { deelFirewall } from "./deel.generated";
import { devtoFirewall } from "./devto.generated";
import { discordFirewall } from "./discord.generated";
import { dropboxFirewall } from "./dropbox.generated";
import { elevenlabsFirewall } from "./elevenlabs.generated";
import { exploriumFirewall } from "./explorium.generated";
import { falFirewall } from "./fal.generated";
import { figmaFirewall } from "./figma.generated";
import { firecrawlFirewall } from "./firecrawl.generated";
import { firefliesFirewall } from "./fireflies.generated";
import { gammaFirewall } from "./gamma.generated";
import { garminConnectFirewall } from "./garmin-connect.generated";
import { githubFirewall } from "./github.generated";
import { gitlabFirewall } from "./gitlab.generated";
import { gmailFirewall } from "./gmail.generated";
import { googleCalendarFirewall } from "./google-calendar.generated";
import { googleDocsFirewall } from "./google-docs.generated";
import { googleDriveFirewall } from "./google-drive.generated";
import { googleSheetsFirewall } from "./google-sheets.generated";
import { granolaFirewall } from "./granola.generated";
import { heygenFirewall } from "./heygen.generated";
import { hubspotFirewall } from "./hubspot.generated";
import { huggingFaceFirewall } from "./hugging-face.generated";
import { humeFirewall } from "./hume.generated";
import { imgurFirewall } from "./imgur.generated";
import { instagramFirewall } from "./instagram.generated";
import { instantlyFirewall } from "./instantly.generated";
import { intercomFirewall } from "./intercom.generated";
import { intervalsIcuFirewall } from "./intervals-icu.generated";
import { jotformFirewall } from "./jotform.generated";
import { larkFirewall } from "./lark.generated";
import { lineFirewall } from "./line.generated";
import { linearFirewall } from "./linear.generated";
import { loopsFirewall } from "./loops.generated";
import { mailsacFirewall } from "./mailsac.generated";
import { mercuryFirewall } from "./mercury.generated";
import { metaAdsFirewall } from "./meta-ads.generated";
import { minimaxFirewall } from "./minimax.generated";
import { mondayFirewall } from "./monday.generated";
import { neonFirewall } from "./neon.generated";
import { notionFirewall } from "./notion.generated";
import { openaiFirewall } from "./openai.generated";
import { outlookCalendarFirewall } from "./outlook-calendar.generated";
import { outlookMailFirewall } from "./outlook-mail.generated";
import { pdf4meFirewall } from "./pdf4me.generated";
import { pdfcoFirewall } from "./pdfco.generated";
import { pdforgeFirewall } from "./pdforge.generated";
import { perplexityFirewall } from "./perplexity.generated";
import { plausibleFirewall } from "./plausible.generated";
import { podchaserFirewall } from "./podchaser.generated";
import { posthogFirewall } from "./posthog.generated";
import { productlaneFirewall } from "./productlane.generated";
import { prismaPostgresFirewall } from "./prisma-postgres.generated";
import { pushinatorFirewall } from "./pushinator.generated";
import { qiitaFirewall } from "./qiita.generated";
import { redditFirewall } from "./reddit.generated";
import { reporteiFirewall } from "./reportei.generated";
import { resendFirewall } from "./resend.generated";
import { revenuecatFirewall } from "./revenuecat.generated";
import { runwayFirewall } from "./runway.generated";
import { scrapeninjaFirewall } from "./scrapeninja.generated";
import { sentryFirewall } from "./sentry.generated";
import { serpapiFirewall } from "./serpapi.generated";
import { shortioFirewall } from "./shortio.generated";
import { similarwebFirewall } from "./similarweb.generated";
import { slackFirewall } from "./slack.generated";
import { spotifyFirewall } from "./spotify.generated";
import { stravaFirewall } from "./strava.generated";
import { stripeFirewall } from "./stripe.generated";
import { supabaseFirewall } from "./supabase.generated";
import { supadataFirewall } from "./supadata.generated";
import { tavilyFirewall } from "./tavily.generated";
import { tldvFirewall } from "./tldv.generated";
import { todoistFirewall } from "./todoist.generated";
import { v0Firewall } from "./v0.generated";
import { vercelFirewall } from "./vercel.generated";
import { webflowFirewall } from "./webflow.generated";
import { wixFirewall } from "./wix.generated";
import { xFirewall } from "./x.generated";
import { xeroFirewall } from "./xero.generated";
import { youtubeFirewall } from "./youtube.generated";
import { zapierFirewall } from "./zapier.generated";
import { zapsignFirewall } from "./zapsign.generated";
import { zeptomailFirewall } from "./zeptomail.generated";

const CONNECTOR_FIREWALLS = {
  agentmail: agentmailFirewall,
  ahrefs: ahrefsFirewall,
  airtable: airtableFirewall,
  apify: apifyFirewall,
  asana: asanaFirewall,
  atlassian: atlassianFirewall,
  axiom: axiomFirewall,
  "brave-search": braveSearchFirewall,
  brevo: brevoFirewall,
  "bright-data": brightDataFirewall,
  browserbase: browserbaseFirewall,
  browserless: browserlessFirewall,
  "cal-com": calComFirewall,
  calendly: calendlyFirewall,
  canva: canvaFirewall,
  clickup: clickupFirewall,
  close: closeFirewall,
  cloudflare: cloudflareFirewall,
  cronlytic: cronlyticFirewall,
  "customer-io": customerIoFirewall,
  deel: deelFirewall,
  deepseek: deepseekFirewall,
  devto: devtoFirewall,
  discord: discordFirewall,
  dropbox: dropboxFirewall,
  elevenlabs: elevenlabsFirewall,
  explorium: exploriumFirewall,
  fal: falFirewall,
  figma: figmaFirewall,
  firecrawl: firecrawlFirewall,
  fireflies: firefliesFirewall,
  gamma: gammaFirewall,
  "garmin-connect": garminConnectFirewall,
  github: githubFirewall,
  gitlab: gitlabFirewall,
  gmail: gmailFirewall,
  "google-calendar": googleCalendarFirewall,
  "google-docs": googleDocsFirewall,
  "google-drive": googleDriveFirewall,
  "google-sheets": googleSheetsFirewall,
  granola: granolaFirewall,
  heygen: heygenFirewall,
  hubspot: hubspotFirewall,
  "hugging-face": huggingFaceFirewall,
  hume: humeFirewall,
  imgur: imgurFirewall,
  instagram: instagramFirewall,
  instantly: instantlyFirewall,
  intercom: intercomFirewall,
  "intervals-icu": intervalsIcuFirewall,
  jotform: jotformFirewall,
  lark: larkFirewall,
  line: lineFirewall,
  linear: linearFirewall,
  loops: loopsFirewall,
  mailsac: mailsacFirewall,
  mercury: mercuryFirewall,
  "meta-ads": metaAdsFirewall,
  minimax: minimaxFirewall,
  monday: mondayFirewall,
  neon: neonFirewall,
  notion: notionFirewall,
  openai: openaiFirewall,
  "outlook-calendar": outlookCalendarFirewall,
  "outlook-mail": outlookMailFirewall,
  pdf4me: pdf4meFirewall,
  pdfco: pdfcoFirewall,
  pdforge: pdforgeFirewall,
  perplexity: perplexityFirewall,
  plausible: plausibleFirewall,
  podchaser: podchaserFirewall,
  posthog: posthogFirewall,
  "prisma-postgres": prismaPostgresFirewall,
  productlane: productlaneFirewall,
  pushinator: pushinatorFirewall,
  qiita: qiitaFirewall,
  reddit: redditFirewall,
  reportei: reporteiFirewall,
  resend: resendFirewall,
  revenuecat: revenuecatFirewall,
  runway: runwayFirewall,
  scrapeninja: scrapeninjaFirewall,
  sentry: sentryFirewall,
  serpapi: serpapiFirewall,
  shortio: shortioFirewall,
  similarweb: similarwebFirewall,
  slack: slackFirewall,
  spotify: spotifyFirewall,
  strava: stravaFirewall,
  stripe: stripeFirewall,
  supabase: supabaseFirewall,
  supadata: supadataFirewall,
  tavily: tavilyFirewall,
  tldv: tldvFirewall,
  todoist: todoistFirewall,
  v0: v0Firewall,
  vercel: vercelFirewall,
  webflow: webflowFirewall,
  wix: wixFirewall,
  x: xFirewall,
  xero: xeroFirewall,
  youtube: youtubeFirewall,
  zapier: zapierFirewall,
  zapsign: zapsignFirewall,
  zeptomail: zeptomailFirewall,
} as const satisfies Partial<Record<ConnectorType, FirewallConfig>>;

/**
 * Expand firewall placeholders to cover all secret names related to the
 * connector.  For each existing placeholder key, find related names via
 * environmentMapping (raw OAuth secret names and sibling aliases) and assign
 * the same placeholder value.
 */
function expandPlaceholders(
  firewall: FirewallConfig,
  connectorType: ConnectorType,
): FirewallConfig {
  if (!firewall.placeholders) return firewall;

  const mapping = getConnectorEnvironmentMapping(connectorType);
  if (Object.keys(mapping).length === 0) return firewall;

  const expanded: Record<string, string> = { ...firewall.placeholders };

  for (const [key, placeholderValue] of Object.entries(firewall.placeholders)) {
    // key is a mapped env var (e.g. GITHUB_TOKEN)
    // → add the raw secret name and any sibling aliases
    const valueRef = mapping[key];
    if (valueRef?.startsWith("$secrets.")) {
      const rawName = valueRef.slice("$secrets.".length);
      if (!expanded[rawName]) {
        expanded[rawName] = placeholderValue;
      }
      for (const [envVar, ref] of Object.entries(mapping)) {
        if (ref === valueRef && !expanded[envVar]) {
          expanded[envVar] = placeholderValue;
        }
      }
    }

    // key is a raw secret name → add all env vars that reference it
    const rawRef = `$secrets.${key}`;
    for (const [envVar, ref] of Object.entries(mapping)) {
      if (ref === rawRef && !expanded[envVar]) {
        expanded[envVar] = placeholderValue;
      }
    }
  }

  return { ...firewall, placeholders: expanded };
}

// Pre-compute expanded placeholders at module load time.
const EXPANDED_CONNECTOR_FIREWALLS = Object.fromEntries(
  Object.entries(CONNECTOR_FIREWALLS).map(([type, firewall]) => [
    type,
    expandPlaceholders(firewall, type as ConnectorType),
  ]),
) as typeof CONNECTOR_FIREWALLS;

/** Connector types that have a firewall config (subset of ConnectorType). */
export type FirewallConnectorType = keyof typeof CONNECTOR_FIREWALLS;

/**
 * Connector types that do not have a firewall config.
 *
 * When adding a new ConnectorType, place it in either CONNECTOR_FIREWALLS
 * or this union. The compile-time assertions below will fail if a
 * ConnectorType is missing from both, or if a type is listed here
 * that already has a firewall config.
 */
export type NonFirewallConnectorType =
  // Dynamic base URL — user-specific, self-hosted, or regional domains
  | "bitrix" // {domain}.bitrix24.com
  | "chatwoot" // self-hosted
  | "cloudinary" // account-specific subdomain
  | "dify" // self-hosted
  | "docusign" // region-specific
  | "jira" // {domain}.atlassian.net (API token auth)
  | "kommo" // {subdomain}.kommo.com
  | "mailchimp" // datacenter-specific (usX.api.mailchimp.com)
  | "make" // regional (eu1/eu2/us1/us2.make.com)
  | "metabase" // self-hosted
  | "minio" // self-hosted
  | "qdrant" // self-hosted / custom cluster URL
  | "salesforce" // instance-specific (*.my.salesforce.com)
  | "twenty" // self-hosted
  | "wrike" // regional ({datacenter}.wrike.com)
  | "zendesk" // {subdomain}.zendesk.com
  // Basic auth — proxy cannot do base64 encoding at runtime
  | "htmlcsstoimage" // HTTP Basic Auth (user-id + api-key)
  | "streak" // HTTP Basic Auth (API key as username)
  // Webhook URL — token embedded in URL, not auth header
  | "discord-webhook" // DISCORD_WEBHOOK_URL
  | "slack-webhook" // SLACK_WEBHOOK_URL
  // Other
  | "computer" // not an API connector
  | "jam"; // no public REST API

/**
 * Compile-time exhaustiveness checks.
 *
 * ValidateNonFirewall: ensures NonFirewallConnectorType only contains
 * connectors that are NOT in FirewallConnectorType.
 *
 * ValidateExhaustive: ensures every ConnectorType is in either
 * FirewallConnectorType or NonFirewallConnectorType.
 */
type ValidateNonFirewall<
  T extends Exclude<ConnectorType, FirewallConnectorType> =
    NonFirewallConnectorType,
> = T;
type ValidateExhaustive<
  T extends never = Exclude<
    ConnectorType,
    FirewallConnectorType | NonFirewallConnectorType
  >,
> = T;
export type ConnectorTypeCoverage = ValidateNonFirewall & ValidateExhaustive;

/** Check if a connector type has a firewall config. */
export function isFirewallConnectorType(
  type: string,
): type is FirewallConnectorType {
  return type in CONNECTOR_FIREWALLS;
}

/** Get the firewall config for a connector type (placeholders pre-expanded). */
export function getConnectorFirewall(
  type: FirewallConnectorType,
): FirewallConfig {
  return EXPANDED_CONNECTOR_FIREWALLS[type];
}
