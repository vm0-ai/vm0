import chalk from "chalk";
import { Command } from "commander";

import { listZeroConnectorCatalogStatus } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { resolveAgentContext } from "../connector/agent-context";
import { findConnectorStatusItem } from "../connector/public-catalog";
import { getPlatformOrigin } from "../doctor/platform-url";
import {
  MAIL_CONNECTOR_SLUG_BY_PROVIDER,
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
      const connectorSlug = MAIL_CONNECTOR_SLUG_BY_PROVIDER[provider];
      const [{ connectors }, agent, origin] = await Promise.all([
        listZeroConnectorCatalogStatus(),
        resolveAgentContext(agentId),
        getPlatformOrigin(),
      ]);
      if (!agent) {
        throw new Error("Agent context could not be loaded");
      }
      const connector = findConnectorStatusItem(connectors, connectorSlug);
      if (!connector) {
        throw new Error(`${provider} is not available`);
      }

      const authorized = agent.authorizedConnectorSlugs.has(connectorSlug);
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
            ? `${origin}/connectors/${connectorSlug}/connect?agentId=${agentId}`
            : `${origin}/connectors`
          : action === "authorize"
            ? `${origin}/connectors/${connectorSlug}/authorize?agentId=${agentId}`
            : action === "connect"
              ? `${origin}/connectors/${connectorSlug}/connect?agentId=${agentId}`
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
        console.log(
          chalk.dim(
            "  After creating a Gmail draft: zero mail link <draft-id>",
          ),
        );
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
