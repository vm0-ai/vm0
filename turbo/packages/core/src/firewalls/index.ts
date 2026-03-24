/**
 * Builtin firewall configs registry.
 *
 * Generated configs are imported here and exposed as a lookup map.
 * The firewall loader checks this registry before falling back to
 * remote GitHub fetch.
 */

import type { FirewallConfig } from "../contracts/firewalls";
import { agentmailFirewall } from "./agentmail.generated";
import { confluenceFirewall } from "./confluence.generated";
import { figmaFirewall } from "./figma.generated";
import { githubFirewall } from "./github.generated";
import { gmailFirewall } from "./gmail.generated";
import { googleCalendarFirewall } from "./google-calendar.generated";
import { googleDocsFirewall } from "./google-docs.generated";
import { googleDriveFirewall } from "./google-drive.generated";
import { googleSheetsFirewall } from "./google-sheets.generated";
import { jiraFirewall } from "./jira.generated";
import { notionFirewall } from "./notion.generated";
import { slackFirewall } from "./slack.generated";
import { vercelFirewall } from "./vercel.generated";

export const builtinFirewalls: Record<string, FirewallConfig> = {
  agentmail: agentmailFirewall,
  confluence: confluenceFirewall,
  figma: figmaFirewall,
  github: githubFirewall,
  gmail: gmailFirewall,
  "google-calendar": googleCalendarFirewall,
  "google-docs": googleDocsFirewall,
  "google-drive": googleDriveFirewall,
  "google-sheets": googleSheetsFirewall,
  jira: jiraFirewall,
  notion: notionFirewall,
  slack: slackFirewall,
  vercel: vercelFirewall,
};
