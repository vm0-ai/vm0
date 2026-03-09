import type { ConnectorType } from "@vm0/core";

import airtableIcon from "./icons/airtable.svg";
import asanaIcon from "./icons/asana.svg";
import canvaIcon from "./icons/canva.svg";
import computerIcon from "./icons/computer.svg";
import deelIcon from "./icons/deel.svg";
import docusignIcon from "./icons/docusign.svg";
import dropboxIcon from "./icons/dropbox.svg";
import figmaIcon from "./icons/figma.svg";
import garminConnectIcon from "./icons/garmin-connect.svg";
import githubIcon from "./icons/github.svg";
import hubspotIcon from "./icons/hubspot.svg";
import intervalsIcuIcon from "./icons/intervals-icu.svg";
import gmailIcon from "./icons/gmail.svg";
import googleCalendarIcon from "./icons/google-calendar.svg";
import googleDocsIcon from "./icons/google-docs.svg";
import googleDriveIcon from "./icons/google-drive.svg";
import googleSheetsIcon from "./icons/google-sheets.svg";
import linearIcon from "./icons/linear.svg";
import mercuryIcon from "./icons/mercury.svg";
import metaAdsIcon from "./icons/meta-ads.svg";
import mondayIcon from "./icons/monday.svg";
import neonIcon from "./icons/neon.svg";
import notionIcon from "./icons/notion.svg";
import redditIcon from "./icons/reddit.svg";
import sentryIcon from "./icons/sentry.svg";
import slackIcon from "./icons/slack.svg";
import stravaIcon from "./icons/strava.svg";
import stripeIcon from "./icons/stripe.svg";
import supabaseIcon from "./icons/supabase.svg";
import todoistIcon from "./icons/todoist.svg";
import vercelIcon from "./icons/vercel.svg";
import webflowIcon from "./icons/webflow.svg";
import xIcon from "./icons/x.svg";
import xeroIcon from "./icons/xero.svg";

const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> = Object.freeze({
  airtable: airtableIcon,
  asana: asanaIcon,
  canva: canvaIcon,
  computer: computerIcon,
  deel: deelIcon,
  docusign: docusignIcon,
  dropbox: dropboxIcon,
  figma: figmaIcon,
  "garmin-connect": garminConnectIcon,
  github: githubIcon,
  gmail: gmailIcon,
  hubspot: hubspotIcon,
  "google-calendar": googleCalendarIcon,
  "google-docs": googleDocsIcon,
  "google-drive": googleDriveIcon,
  "google-sheets": googleSheetsIcon,
  "intervals-icu": intervalsIcuIcon,
  linear: linearIcon,
  mercury: mercuryIcon,
  "meta-ads": metaAdsIcon,
  monday: mondayIcon,
  neon: neonIcon,
  notion: notionIcon,
  reddit: redditIcon,
  sentry: sentryIcon,
  slack: slackIcon,
  strava: stravaIcon,
  stripe: stripeIcon,
  supabase: supabaseIcon,
  todoist: todoistIcon,
  vercel: vercelIcon,
  webflow: webflowIcon,
  x: xIcon,
  xero: xeroIcon,
});

export function ConnectorIcon({
  type,
  size = 28,
}: {
  type: ConnectorType;
  size?: number;
}) {
  const icon = CONNECTOR_ICONS[type];
  return (
    <img src={icon} width={size} height={size} alt="" className="shrink-0" />
  );
}
