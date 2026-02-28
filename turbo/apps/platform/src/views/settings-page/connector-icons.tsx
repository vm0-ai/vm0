import type { ConnectorType } from "@vm0/core";

import githubIcon from "./icons/github.svg";
import notionIcon from "./icons/notion.svg";
import computerIcon from "./icons/computer.svg";
import slackIcon from "./icons/slack.svg";

const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> = Object.freeze({
  github: githubIcon,
  notion: notionIcon,
  computer: computerIcon,
  slack: slackIcon,
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
