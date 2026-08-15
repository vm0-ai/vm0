import chalk from "chalk";
import type { PublicConnectorStatus } from "./public-catalog";

function renderIdentity(connector: PublicConnectorStatus): string {
  if (connector.connection?.externalUsername) {
    return `@${connector.connection.externalUsername}`;
  }
  if (connector.connection?.externalEmail)
    return connector.connection.externalEmail;
  return "-";
}

export function renderConnectedAsCell(
  connector: PublicConnectorStatus | undefined,
): string {
  if (!connector || connector.connectionStatus === "not-connected") {
    return chalk.dim("(not connected)");
  }
  const identity = renderIdentity(connector);
  if (connector.connectionStatus === "reconnect-required") {
    return chalk.yellow(`${identity} (reconnect needed)`);
  }
  if (
    connector.scopeMismatch ||
    connector.connectionStatus === "scope-mismatch"
  ) {
    return chalk.yellow(`${identity} (permissions update available)`);
  }
  return identity;
}

const ESC = "\u001b";
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

export function padEndAnsi(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, width - visible));
}
