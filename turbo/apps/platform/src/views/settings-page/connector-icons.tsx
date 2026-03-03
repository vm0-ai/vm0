import type { ConnectorType } from "@vm0/core";

import computerIcon from "./icons/computer.svg";
import deelIcon from "./icons/deel.svg";
import docusignIcon from "./icons/docusign.svg";
import dropboxIcon from "./icons/dropbox.svg";
import figmaIcon from "./icons/figma.svg";
import garminConnectIcon from "./icons/garmin-connect.svg";
import githubIcon from "./icons/github.svg";
import gmailIcon from "./icons/gmail.svg";
import googleCalendarIcon from "./icons/google-calendar.svg";
import googleDocsIcon from "./icons/google-docs.svg";
import googleDriveIcon from "./icons/google-drive.svg";
import googleSheetsIcon from "./icons/google-sheets.svg";
import linearIcon from "./icons/linear.svg";
import mercuryIcon from "./icons/mercury.svg";
import notionIcon from "./icons/notion.svg";
import slackIcon from "./icons/slack.svg";
import stravaIcon from "./icons/strava.svg";
import xIcon from "./icons/x.svg";

const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> = Object.freeze({
  computer: computerIcon,
  deel: deelIcon,
  docusign: docusignIcon,
  dropbox: dropboxIcon,
  figma: figmaIcon,
  "garmin-connect": garminConnectIcon,
  github: githubIcon,
  gmail: gmailIcon,
  "google-calendar": googleCalendarIcon,
  "google-docs": googleDocsIcon,
  "google-drive": googleDriveIcon,
  "google-sheets": googleSheetsIcon,
  linear: linearIcon,
  mercury: mercuryIcon,
  notion: notionIcon,
  slack: slackIcon,
  strava: stravaIcon,
  x: xIcon,
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
