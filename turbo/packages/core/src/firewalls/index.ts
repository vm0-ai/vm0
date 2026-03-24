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
import { calendlyFirewall } from "./calendly.generated";
import { clickupFirewall } from "./clickup.generated";
import { closeFirewall } from "./close.generated";
import { cloudflareFirewall } from "./cloudflare.generated";
import { confluenceFirewall } from "./confluence.generated";
import { deepseekFirewall } from "./deepseek.generated";
import { devtoFirewall } from "./devto.generated";
import { discordFirewall } from "./discord.generated";
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
import { heygenFirewall } from "./heygen.generated";
import { hubspotFirewall } from "./hubspot.generated";
import { huggingFaceFirewall } from "./hugging-face.generated";
import { intercomFirewall } from "./intercom.generated";
import { jiraFirewall } from "./jira.generated";
import { linearFirewall } from "./linear.generated";
import { loopsFirewall } from "./loops.generated";
import { mondayFirewall } from "./monday.generated";
import { neonFirewall } from "./neon.generated";
import { notionFirewall } from "./notion.generated";
import { openaiFirewall } from "./openai.generated";
import { perplexityFirewall } from "./perplexity.generated";
import { plausibleFirewall } from "./plausible.generated";
import { posthogFirewall } from "./posthog.generated";
import { resendFirewall } from "./resend.generated";
import { runwayFirewall } from "./runway.generated";
import { sentryFirewall } from "./sentry.generated";
import { serpapiFirewall } from "./serpapi.generated";
import { shortioFirewall } from "./shortio.generated";
import { slackFirewall } from "./slack.generated";
import { stripeFirewall } from "./stripe.generated";
import { supabaseFirewall } from "./supabase.generated";
import { tavilyFirewall } from "./tavily.generated";
import { todoistFirewall } from "./todoist.generated";
import { vercelFirewall } from "./vercel.generated";
import { xFirewall } from "./x.generated";
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
  calendly: calendlyFirewall,
  clickup: clickupFirewall,
  close: closeFirewall,
  cloudflare: cloudflareFirewall,
  confluence: confluenceFirewall,
  deepseek: deepseekFirewall,
  devto: devtoFirewall,
  discord: discordFirewall,
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
  heygen: heygenFirewall,
  hubspot: hubspotFirewall,
  "hugging-face": huggingFaceFirewall,
  intercom: intercomFirewall,
  jira: jiraFirewall,
  linear: linearFirewall,
  loops: loopsFirewall,
  monday: mondayFirewall,
  neon: neonFirewall,
  notion: notionFirewall,
  openai: openaiFirewall,
  perplexity: perplexityFirewall,
  plausible: plausibleFirewall,
  posthog: posthogFirewall,
  resend: resendFirewall,
  runway: runwayFirewall,
  sentry: sentryFirewall,
  serpapi: serpapiFirewall,
  shortio: shortioFirewall,
  slack: slackFirewall,
  stripe: stripeFirewall,
  supabase: supabaseFirewall,
  tavily: tavilyFirewall,
  todoist: todoistFirewall,
  vercel: vercelFirewall,
  x: xFirewall,
  youtube: youtubeFirewall,
  zapier: zapierFirewall,
  zapsign: zapsignFirewall,
  zeptomail: zeptomailFirewall,
};
