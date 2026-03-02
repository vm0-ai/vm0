import type { ConnectorType } from "@vm0/core";

import computerIcon from "./icons/computer.svg";
import deelIcon from "./icons/deel.svg";
import dropboxIcon from "./icons/dropbox.svg";
import figmaIcon from "./icons/figma.svg";
import garminConnectIcon from "./icons/garmin-connect.svg";
import githubIcon from "./icons/github.svg";
import gmailIcon from "./icons/gmail.svg";
import linearIcon from "./icons/linear.svg";
import notionIcon from "./icons/notion.svg";
import slackIcon from "./icons/slack.svg";
import stravaIcon from "./icons/strava.svg";

const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> = Object.freeze({
  computer: computerIcon,
  deel: deelIcon,
  dropbox: dropboxIcon,
  figma: figmaIcon,
  "garmin-connect": garminConnectIcon,
  github: githubIcon,
  gmail: gmailIcon,
  linear: linearIcon,
  notion: notionIcon,
  slack: slackIcon,
  strava: stravaIcon,
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
