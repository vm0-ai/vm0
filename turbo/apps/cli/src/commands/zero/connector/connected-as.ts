import chalk from "chalk";
import { hasRequiredScopes, type ConnectorListResponse } from "@vm0/core";

type Connector = ConnectorListResponse["connectors"][number];

function renderIdentity(connector: Connector): string {
  if (connector.externalUsername) return `@${connector.externalUsername}`;
  if (connector.externalEmail) return connector.externalEmail;
  return "-";
}

export function renderConnectedAsCell(
  connector: Connector | undefined,
): string {
  if (!connector) return chalk.dim("(not connected)");
  const identity = renderIdentity(connector);
  if (connector.needsReconnect) {
    return chalk.yellow(`${identity} (reconnect needed)`);
  }
  const scopeMismatch =
    connector.authMethod === "oauth" &&
    !hasRequiredScopes(connector.type, connector.oauthScopes);
  if (scopeMismatch) {
    return chalk.yellow(`${identity} (permissions update available)`);
  }
  return identity;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

export function padEndAnsi(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, width - visible));
}
