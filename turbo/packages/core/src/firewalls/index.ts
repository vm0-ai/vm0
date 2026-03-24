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
import { asanaFirewall } from "./asana.generated";
import { axiomFirewall } from "./axiom.generated";
import { cloudflareFirewall } from "./cloudflare.generated";
import { confluenceFirewall } from "./confluence.generated";
import { discordFirewall } from "./discord.generated";
import { elevenlabsFirewall } from "./elevenlabs.generated";
import { figmaFirewall } from "./figma.generated";
import { githubFirewall } from "./github.generated";
import { gitlabFirewall } from "./gitlab.generated";
import { gmailFirewall } from "./gmail.generated";
import { googleCalendarFirewall } from "./google-calendar.generated";
import { googleDocsFirewall } from "./google-docs.generated";
import { googleDriveFirewall } from "./google-drive.generated";
import { googleSheetsFirewall } from "./google-sheets.generated";
import { hubspotFirewall } from "./hubspot.generated";
import { jiraFirewall } from "./jira.generated";
import { linearFirewall } from "./linear.generated";
import { notionFirewall } from "./notion.generated";
import { openaiFirewall } from "./openai.generated";
import { resendFirewall } from "./resend.generated";
import { slackFirewall } from "./slack.generated";
import { stripeFirewall } from "./stripe.generated";
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
  asana: asanaFirewall,
  axiom: axiomFirewall,
  cloudflare: cloudflareFirewall,
  confluence: confluenceFirewall,
  discord: discordFirewall,
  elevenlabs: elevenlabsFirewall,
  figma: figmaFirewall,
  github: githubFirewall,
  gitlab: gitlabFirewall,
  gmail: gmailFirewall,
  "google-calendar": googleCalendarFirewall,
  "google-docs": googleDocsFirewall,
  "google-drive": googleDriveFirewall,
  "google-sheets": googleSheetsFirewall,
  hubspot: hubspotFirewall,
  jira: jiraFirewall,
  linear: linearFirewall,
  notion: notionFirewall,
  openai: openaiFirewall,
  resend: resendFirewall,
  slack: slackFirewall,
  stripe: stripeFirewall,
  vercel: vercelFirewall,
  x: xFirewall,
  youtube: youtubeFirewall,
  zapier: zapierFirewall,
  zapsign: zapsignFirewall,
  zeptomail: zeptomailFirewall,
};
