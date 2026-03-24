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
import { confluenceFirewall } from "./confluence.generated";
import { figmaFirewall } from "./figma.generated";
import { githubFirewall } from "./github.generated";
import { gmailFirewall } from "./gmail.generated";
import { googleCalendarFirewall } from "./google-calendar.generated";
import { googleDocsFirewall } from "./google-docs.generated";
import { googleDriveFirewall } from "./google-drive.generated";
import { googleSheetsFirewall } from "./google-sheets.generated";
import { jiraFirewall } from "./jira.generated";
import { linearFirewall } from "./linear.generated";
import { notionFirewall } from "./notion.generated";
import { slackFirewall } from "./slack.generated";
import { vercelFirewall } from "./vercel.generated";
import { zapierFirewall } from "./zapier.generated";
import { zapsignFirewall } from "./zapsign.generated";
import { zeptomailFirewall } from "./zeptomail.generated";

export const builtinFirewalls: Record<string, FirewallConfig> = {
  agentmail: agentmailFirewall,
  ahrefs: ahrefsFirewall,
  airtable: airtableFirewall,
  asana: asanaFirewall,
  axiom: axiomFirewall,
  confluence: confluenceFirewall,
  figma: figmaFirewall,
  github: githubFirewall,
  gmail: gmailFirewall,
  "google-calendar": googleCalendarFirewall,
  "google-docs": googleDocsFirewall,
  "google-drive": googleDriveFirewall,
  "google-sheets": googleSheetsFirewall,
  jira: jiraFirewall,
  linear: linearFirewall,
  notion: notionFirewall,
  slack: slackFirewall,
  vercel: vercelFirewall,
  zapier: zapierFirewall,
  zapsign: zapsignFirewall,
  zeptomail: zeptomailFirewall,
};
