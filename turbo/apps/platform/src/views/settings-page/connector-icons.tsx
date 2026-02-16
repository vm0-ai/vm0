import type { ConnectorType } from "@vm0/core";

import githubIcon from "./icons/github.svg";
import notionIcon from "./icons/notion.svg";
import computerIcon from "./icons/computer.svg";
import gmailIcon from "./icons/gmail.svg";

const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> = Object.freeze({
  github: githubIcon,
  notion: notionIcon,
  computer: computerIcon,
  gmail: gmailIcon,
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
