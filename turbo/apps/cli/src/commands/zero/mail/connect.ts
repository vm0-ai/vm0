import chalk from "chalk";
import { Command } from "commander";

import { listZeroConnectorCatalogStatus } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { resolveAgentContext } from "../connector/agent-context";
import { findConnectorStatusItem } from "../connector/public-catalog";
import { getPlatformOrigin } from "../doctor/platform-url";
import {
  MAIL_CONNECTOR_REF,
  currentAgentId,
  parseMailProvider,
} from "./shared";

interface ConnectOptions {
  readonly json?: boolean;
}

export const connectCommand = new Command()
  .name("connect")
  .description("Get a connect or authorization link for a mail provider")
  .argument("<provider>", "Mail provider: gmail or outlook")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (providerValue: string, options: ConnectOptions) => {
      const provider = parseMailProvider(providerValue);
      const agentId = currentAgentId();
      const connectorRef = MAIL_CONNECTOR_REF[provider];
      const [{ connectors }, agent, origin] = await Promise.all([
        listZeroConnectorCatalogStatus(),
        resolveAgentContext(agentId),
        getPlatformOrigin(),
      ]);
      if (!agent) {
        throw new Error("Agent context could not be loaded");
      }
      const connector = findConnectorStatusItem(connectors, connectorRef);
      if (!connector) {
        throw new Error(`${provider} is not available`);
      }

      const authorized = agent.authorizedTypes.has(connectorRef);
      const action =
        connector.connectionStatus === "reconnect-required" ||
        connector.connectionStatus === "scope-mismatch"
          ? "reconnect"
          : connector.connected && !authorized
            ? "authorize"
            : !connector.connected
              ? "connect"
              : "ready";
      const url =
        action === "reconnect"
          ? connector.connectionStatus === "scope-mismatch"
            ? `${origin}/connectors/${connectorRef}/connect?agentId=${agentId}`
            : `${origin}/connectors`
          : action === "authorize"
            ? `${origin}/connectors/${connectorRef}/authorize?agentId=${agentId}`
            : action === "connect"
              ? `${origin}/connectors/${connectorRef}/connect?agentId=${agentId}`
              : null;

      if (options.json) {
        console.log(JSON.stringify({ provider, action, url }));
        return;
      }
      if (!url) {
        console.log(chalk.green(`✓ ${connector.label} is ready`));
        console.log(
          chalk.dim(`  Sender: ${connector.connection?.externalEmail}`),
        );
        console.log(chalk.dim("  Run: zero mail send --help"));
        return;
      }
      const label =
        action === "authorize"
          ? `Authorize ${connector.label}`
          : action === "reconnect"
            ? `Reconnect ${connector.label}`
            : `Connect ${connector.label}`;
      console.log(`${label}: [${label}](${url})`);
    }),
  );
