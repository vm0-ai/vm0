/**
 * Builtin firewall configs registry.
 *
 * Generated configs are imported here and exposed as a lookup map.
 * The firewall loader checks this registry before falling back to
 * remote GitHub fetch.
 */

import type { FirewallConfig } from "../contracts/firewalls";
import { agentmailFirewall } from "./agentmail.generated";
import { ahrefsFirewall } from "./ahrefs.generated";
import { airtableFirewall } from "./airtable.generated";
import { apifyFirewall } from "./apify.generated";
import { asanaFirewall } from "./asana.generated";
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
import { confluenceFirewall } from "./confluence.generated";
import { cronlyticFirewall } from "./cronlytic.generated";
import { customerIoFirewall } from "./customer-io.generated";
import { deepseekFirewall } from "./deepseek.generated";
import { deelFirewall } from "./deel.generated";
import { devtoFirewall } from "./devto.generated";
import { discordFirewall } from "./discord.generated";
import { dropboxFirewall } from "./dropbox.generated";
import { elevenlabsFirewall } from "./elevenlabs.generated";
import { falFirewall } from "./fal.generated";
import { figmaFirewall } from "./figma.generated";
import { firecrawlFirewall } from "./firecrawl.generated";
import { firefliesFirewall } from "./fireflies.generated";
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
import { instantlyFirewall } from "./instantly.generated";
import { intercomFirewall } from "./intercom.generated";
import { jiraFirewall } from "./jira.generated";
import { jotformFirewall } from "./jotform.generated";
import { larkFirewall } from "./lark.generated";
import { lineFirewall } from "./line.generated";
import { linearFirewall } from "./linear.generated";
import { loopsFirewall } from "./loops.generated";
import { mercuryFirewall } from "./mercury.generated";
import { minimaxFirewall } from "./minimax.generated";
import { mondayFirewall } from "./monday.generated";
import { neonFirewall } from "./neon.generated";
import { notionFirewall } from "./notion.generated";
import { openaiFirewall } from "./openai.generated";
import { perplexityFirewall } from "./perplexity.generated";
import { plausibleFirewall } from "./plausible.generated";
import { posthogFirewall } from "./posthog.generated";
import { qiitaFirewall } from "./qiita.generated";
import { redditFirewall } from "./reddit.generated";
import { resendFirewall } from "./resend.generated";
import { runwayFirewall } from "./runway.generated";
import { sentryFirewall } from "./sentry.generated";
import { serpapiFirewall } from "./serpapi.generated";
import { shortioFirewall } from "./shortio.generated";
import { slackFirewall } from "./slack.generated";
import { stravaFirewall } from "./strava.generated";
import { stripeFirewall } from "./stripe.generated";
import { supabaseFirewall } from "./supabase.generated";
import { supadataFirewall } from "./supadata.generated";
import { tavilyFirewall } from "./tavily.generated";
import { tldvFirewall } from "./tldv.generated";
import { todoistFirewall } from "./todoist.generated";
import { vercelFirewall } from "./vercel.generated";
import { webflowFirewall } from "./webflow.generated";
import { wixFirewall } from "./wix.generated";
import { xFirewall } from "./x.generated";
import { xeroFirewall } from "./xero.generated";
import { youtubeFirewall } from "./youtube.generated";
import { zapierFirewall } from "./zapier.generated";
import { zapsignFirewall } from "./zapsign.generated";
import { zeptomailFirewall } from "./zeptomail.generated";

export const builtinFirewalls: Record<string, FirewallConfig> = {
  agentmail: agentmailFirewall,
  ahrefs: ahrefsFirewall,
  airtable: airtableFirewall,
  apify: apifyFirewall,
  asana: asanaFirewall,
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
  confluence: confluenceFirewall,
  cronlytic: cronlyticFirewall,
  "customer-io": customerIoFirewall,
  deepseek: deepseekFirewall,
  deel: deelFirewall,
  devto: devtoFirewall,
  discord: discordFirewall,
  dropbox: dropboxFirewall,
  elevenlabs: elevenlabsFirewall,
  fal: falFirewall,
  figma: figmaFirewall,
  firecrawl: firecrawlFirewall,
  fireflies: firefliesFirewall,
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
  instantly: instantlyFirewall,
  intercom: intercomFirewall,
  jira: jiraFirewall,
  jotform: jotformFirewall,
  lark: larkFirewall,
  line: lineFirewall,
  linear: linearFirewall,
  loops: loopsFirewall,
  mercury: mercuryFirewall,
  minimax: minimaxFirewall,
  monday: mondayFirewall,
  neon: neonFirewall,
  notion: notionFirewall,
  openai: openaiFirewall,
  perplexity: perplexityFirewall,
  plausible: plausibleFirewall,
  posthog: posthogFirewall,
  qiita: qiitaFirewall,
  reddit: redditFirewall,
  resend: resendFirewall,
  runway: runwayFirewall,
  sentry: sentryFirewall,
  serpapi: serpapiFirewall,
  shortio: shortioFirewall,
  slack: slackFirewall,
  strava: stravaFirewall,
  stripe: stripeFirewall,
  supabase: supabaseFirewall,
  supadata: supadataFirewall,
  tavily: tavilyFirewall,
  tldv: tldvFirewall,
  todoist: todoistFirewall,
  vercel: vercelFirewall,
  webflow: webflowFirewall,
  wix: wixFirewall,
  x: xFirewall,
  xero: xeroFirewall,
  youtube: youtubeFirewall,
  zapier: zapierFirewall,
  zapsign: zapsignFirewall,
  zeptomail: zeptomailFirewall,
};
